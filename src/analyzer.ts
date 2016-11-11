/**
 * @license
 * Copyright (c) 2016 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at
 * http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at
 * http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at
 * http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at
 * http://polymer.github.io/PATENTS.txt
 */

import {Deferred, Resolver as HydrolysisResolver} from 'hydrolysis';
import * as path from 'path';
import {Analyzer} from 'polymer-analyzer';
import {UrlLoader} from 'polymer-analyzer/lib/url-loader/url-loader';
import {Severity, Warning} from 'polymer-analyzer/lib/warning/warning';
import {PassThrough} from 'stream';

import File = require('vinyl');
import {src as vinylSrc} from 'vinyl-fs';
import {parse as parseUrl} from 'url';
import * as logging from 'plylog';
import {ProjectConfig} from 'polymer-project-config';

import {VinylReaderTransform} from './streams';
import {urlFromPath, pathFromUrl} from './path-transformers';


const minimatchAll = require('minimatch-all');
const logger = logging.getLogger('cli.build.analyzer');

export interface DocumentDeps {
  imports: Array<string>;
  scripts: Array<string>;
  styles: Array<string>;
}

export interface DepsIndex {
  // An index of dependency -> fragments that depend on it
  depsToFragments: Map<string, string[]>;
  // TODO(garlicnation): Remove this map.
  // An index of fragments -> html dependencies
  fragmentToDeps: Map<string, string[]>;
  // A map from frament urls to html, js, and css dependencies.
  fragmentToFullDeps: Map<string, DocumentDeps>;
}

/**
 * Detects if a url is external by checking it's protocol. Also checks if it
 * starts with '//', which can be an alias to the page's current protocol
 * in the browser.
 */
function isDependencyExternal(url: string) {
  // TODO(fks) 08-01-2016: Add additional check for files on current hostname
  // but external to this application root. Ignore them.
  return parseUrl(url).protocol !== null || url.startsWith('//');
}

/**
 * Get a longer, single-line error message for logging and exeption-handling
 * analysis Warning objects.
 *
 * Note: We cannot use WarningPrinter.printWarning() from the polymer-analyzer
 * codebase because after minification & optimization its reported source
 * ranges don't match the original source code. Instead we use this custom
 * message generator that only includes the file name in the error message.
 */
function getFullWarningMessage(warning: Warning): string {
  return `In ${warning.sourceRange.file}: [${warning.code}] - ${warning.message
  }`;
}

export class StreamAnalyzer {
  config: ProjectConfig;

  loader: StreamLoader;
  analyzer: Analyzer;

  private _sourcesStream: NodeJS.ReadWriteStream;
  private _sourcesOutputStream = new PassThrough({objectMode: true});
  private _dependenciesStream = new PassThrough({objectMode: true});
  private _dependenciesOutputStream = new VinylReaderTransform();

  files = new Map<string, File>();
  warnings = new Set<Warning>();
  allFragmentsToAnalyze: Set<string>;
  foundDependencies = new Set<string>();

  analyzeDependencies: Promise<DepsIndex>;
  _dependencyAnalysis: DepsIndex = {
    depsToFragments: new Map(),
    fragmentToDeps: new Map(),
    fragmentToFullDeps: new Map()
  };
  _resolveDependencyAnalysis: (index: DepsIndex) => void;

  constructor(config: ProjectConfig) {
    this.config = config;

    this.loader = new StreamLoader(this);
    this.analyzer = new Analyzer({
      urlLoader: this.loader,
    });

    this.allFragmentsToAnalyze = new Set(this.config.allFragments);
    this.analyzeDependencies = new Promise((resolve, _reject) => {
      this._resolveDependencyAnalysis = resolve;
    });
  }

  /**
   * Start the analyzer's source stream by creating a new vinyl-fs stream. This
   * will kick off analysis and start sending files through our sources &
   * dependencies streams.
   */
  start() {
    // Create the stream of source files to analyze.
    this._sourcesStream = vinylSrc(this.config.sources, {
      cwdbase: true,
      nodir: true,
    });

    // Connect the sources & dependencies input streams to their output
    // streams. We use this input/output stream design to protect the consumer
    // from accidentally starting the build before they are ready. By only
    // piping the two streams together here, we can make sure that the input
    // streams aren't referenced (and started) until this moment.
    this._sourcesStream.pipe(this._sourcesOutputStream);
    this._dependenciesStream.pipe(this._dependenciesOutputStream);

    // Analyze all files passing through the build.
    this._sourcesOutputStream.on('data', (file: File) => {
      this._analyzeFile(file);
    });
    this._dependenciesOutputStream.on('data', (file: File) => {
      this._analyzeFile(file);
    });
  }

  /**
   * Return _dependenciesOutputStream, which will contain fully loaded file
   * objects for each dependency.
   */
  get dependencies(): NodeJS.ReadableStream {
    return this._dependenciesOutputStream;
  }

  /**
   * Return _sourcesOutputStream, which will contain fully loaded file
   * objects for each source.
   */
  get sources(): NodeJS.ReadableStream {
    return this._sourcesOutputStream;
  }

  private async _analyzeFile(file: File): Promise<void> {
    const filePath = file.path;
    this.addFile(file);

    // If our resolver is waiting for this file, resolve its deferred loader
    if (this.loader.hasDeferredFile(filePath)) {
      this.loader.resolveDeferredFile(filePath, file);
    }

    // If the file is a fragment, begin analysis on its dependencies
    if (this.config.isFragment(file.path)) {
      const deps =
          await this._getDependencies(urlFromPath(this.config.root, filePath));
      this._addDependencies(filePath, deps);
      this.allFragmentsToAnalyze.delete(filePath);
      // If there are no more fragments to analyze, we are done
      if (this.allFragmentsToAnalyze.size === 0) {
        this._done();
      }
    }
  }

  /**
   * Called when analysis is complete and there are no more files to analyze.
   * Checks for serious errors before resolving its dependency analysis and
   * ending the dependency stream that it control.
   */
  private _done() {
    this.printWarnings();
    const allWarningCount = this.countWarningsByType();
    const errorWarningCount = allWarningCount.get(Severity.ERROR);

    // If any ERROR warnings occurred, propagate an error in the build stream
    if (errorWarningCount > 0) {
      const err =
          new Error(`${errorWarningCount} error(s) occurred during build.`);
      this._sourcesOutputStream.emit('error', err);
      this._dependenciesOutputStream.emit('error', err);
      return;
    }

    // If stream finished with files that still needed to be loaded, error out
    if (this.loader.hasDeferredFiles()) {
      for (const fileUrl of this.loader.deferredFiles.keys()) {
        logger.error(`${fileUrl} never loaded`);
      }
      const err = new Error(
          this.loader.deferredFiles.size + ` deferred files were never loaded`);
      this._sourcesOutputStream.emit('error', err);
      this._dependenciesOutputStream.emit('error', err);
      return;
    }

    // Resolve our dependency analysis promise now that we have seen all files
    this._dependenciesStream.end();
    this._resolveDependencyAnalysis(this._dependencyAnalysis);
  }

  getFile(filepath: string): File {
    const url = urlFromPath(this.config.root, filepath);
    return this.getFileByUrl(url);
  }

  getFileByUrl(url: string): File {
    if (url.startsWith('/')) {
      url = url.substring(1);
    }
    return this.files.get(url);
  }

  /**
   * A side-channel to add files to the loader that did not come throgh the
   * stream transformation. This is for generated files, like
   * shared-bundle.html. This should probably be refactored so that the files
   * can be injected into the stream.
   */
  addFile(file: File): void {
    logger.debug(`addFile: ${file.path}`);
    // Badly-behaved upstream transformers (looking at you gulp-html-minifier)
    // may use posix path separators on Windows.
    const filepath = path.normalize(file.path);
    // Store only root-relative paths, in URL/posix format
    this.files.set(urlFromPath(this.config.root, filepath), file);
  }

  printWarnings(): void {
    for (const warning of this.warnings) {
      const message = getFullWarningMessage(warning);
      if (warning.severity === Severity.ERROR) {
        logger.error(message);
      } else if (warning.severity === Severity.WARNING) {
        logger.warn(message);
      } else {
        logger.debug(message);
      }
    }
  }

  private countWarningsByType(): Map<Severity, number> {
    const errorCountMap = new Map<Severity, number>();
    errorCountMap.set(Severity.INFO, 0);
    errorCountMap.set(Severity.WARNING, 0);
    errorCountMap.set(Severity.ERROR, 0);
    for (const warning of this.warnings) {
      errorCountMap.set(
          warning.severity, errorCountMap.get(warning.severity) + 1);
    }
    return errorCountMap;
  }


  /**
   * Attempts to retreive document-order transitive dependencies for `url`.
   */
  async _getDependencies(url: string): Promise<DocumentDeps> {
    const doc = await this.analyzer.analyze(url);

    doc.getWarnings(true).forEach(w => this.warnings.add(w));

    const scripts = new Set<string>();
    const styles = new Set<string>();
    const imports = new Set<string>();

    for (const importDep of doc.getByKind('import')) {
      const importUrl = importDep.url;
      if (isDependencyExternal(importUrl)) {
        logger.debug(`ignoring external dependency: ${importUrl}`);
      } else if (importDep.type === 'html-script') {
        scripts.add(importUrl);
      } else if (importDep.type === 'html-style') {
        styles.add(importUrl);
      } else if (importDep.type === 'html-import') {
        imports.add(importUrl);
      } else {
        logger.debug(`unexpected import type encountered: ${importDep.type}`);
      }
    }

    const deps = {
      scripts: Array.from(scripts),
      styles: Array.from(styles),
      imports: Array.from(imports),
    };
    logger.debug(`dependencies analyzed for: ${url}`, deps);
    return deps;
  }

  _addDependencies(filePath: string, deps: DocumentDeps) {
    // Make sure function is being called properly
    if (!this.allFragmentsToAnalyze.has(filePath)) {
      throw new Error(`Dependency analysis incorrectly called for ${filePath}`);
    }

    // Add dependencies to _dependencyAnalysis object, and push them through
    // the dependency stream.
    this._dependencyAnalysis.fragmentToFullDeps.set(filePath, deps);
    this._dependencyAnalysis.fragmentToDeps.set(filePath, deps.imports);
    deps.imports.forEach((url) => {
      const entrypointList: string[] =
          this._dependencyAnalysis.depsToFragments.get(url);
      if (entrypointList) {
        entrypointList.push(filePath);
      } else {
        this._dependencyAnalysis.depsToFragments.set(url, [filePath]);
      }
    });
  }

  /**
   * Process the given dependency before pushing it through the stream.
   * Each dependency is only pushed through once to avoid duplicates.
   */
  pushDependency(dependencyUrl: string) {
    if (this.getFileByUrl(dependencyUrl)) {
      logger.debug(
          'dependency has already been pushed, ignoring...',
          {dep: dependencyUrl});
      return;
    }

    const dependencyFilePath = pathFromUrl(this.config.root, dependencyUrl);
    if (minimatchAll(dependencyFilePath, this.config.sources)) {
      logger.debug(
          'dependency is a source file, ignoring...', {dep: dependencyUrl});
      return;
    }

    logger.debug(
        'new dependency found, pushing into dependency stream...',
        dependencyFilePath);
    this._dependenciesStream.push(dependencyFilePath);
  }
}

// TODO(fks) 09-21-2016: Remove once the move to polymer-analyzer is completed
export interface BackwardsCompatibleUrlLoader extends UrlLoader,
                                                      HydrolysisResolver {}
;

export type DeferredFileCallback = (a: string) => string;

export class StreamLoader implements BackwardsCompatibleUrlLoader {
  config: ProjectConfig;
  analyzer: StreamAnalyzer;

  // Store files that have not yet entered the Analyzer stream here.
  // Later, when the file is seen, the DeferredFileCallback can be
  // called with the file contents to resolve its loading.
  deferredFiles = new Map<string, DeferredFileCallback>();

  constructor(analyzer: StreamAnalyzer) {
    this.analyzer = analyzer;
    this.config = this.analyzer.config;
  }

  hasDeferredFile(filePath: string): boolean {
    return this.deferredFiles.has(filePath);
  }

  hasDeferredFiles(): boolean {
    return this.deferredFiles.size > 0;
  }

  resolveDeferredFile(filePath: string, file: File): void {
    const deferred = this.deferredFiles.get(filePath);
    deferred(file.contents.toString());
    this.deferredFiles.delete(filePath);
  }

  canLoad(_url: string): boolean {
    // We want to return true for all files. Even external files, so that we
    // can resolve them as empty strings for now.
    return true;
  }

  load(url: string): Promise<string> {
    logger.debug(`loading: ${url}`);
    const urlObject = parseUrl(url);

    // Resolve external files as empty strings. We filter these out later
    // in the analysis process to make sure they aren't included in the build.
    if (isDependencyExternal(url)) {
      return Promise.resolve('');
    }

    const urlPath = decodeURIComponent(urlObject.pathname);
    const filePath = pathFromUrl(this.config.root, urlPath);
    const file = this.analyzer.getFile(filePath);

    if (file) {
      return Promise.resolve(file.contents.toString());
    }

    let callback: DeferredFileCallback;
    const waitForFile =
        new Promise((resolve: DeferredFileCallback, _reject: () => any) => {
          callback = resolve;
        });
    this.deferredFiles.set(filePath, callback);
    this.analyzer.pushDependency(urlPath);
    return waitForFile;
  }

  /**
   * Wraps the load() method to work in a way that is compliant with vulcanize
   * & the old UrlResolver interface. To be removed once migration from
   * hydrolosis to polymer-analyzer is complete.
   */
  accept(url: string, deferred: Deferred<string>): boolean {
    if (this.canLoad(url)) {
      this.load(url).then(deferred.resolve);
      return true;
    }
    return false;
  }
}
