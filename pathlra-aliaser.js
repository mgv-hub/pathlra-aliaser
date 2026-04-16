"use strict";

/**
 * pathlra-aliaser v4.6.12
 *
 * Ultra-fast, high-performance path alias resolver and module loader enhancer
 * Developed by hub-mgv with extreme focus on speed, security, and developer experience
 *
 * Core Features
 * - Sub-millisecond alias resolution <0.1ms typical
 * - Dual resolution strategies:
 *     • LINEAR scan for small sets (<100 aliases) — optimized further for <10 minimal mode
 *     • RADIX tree for large sets (100+ aliases) — O(k) prefix matching
 * - Lightweight LRU cache with batch eviction (10% per overflow)
 * - Zero external dependencies — pure Node.js
 * - Secure input validation to prevent path traversal / injection
 * - Dynamic alias targets via handler functions
 * - Automatic registration from package.json (any key starting with 'path_aliaser')
 * - Custom module directories (like private node_modules)
 * - Hot-reload support in development (opt-in)
 * - Verbose/debug mode for tracing resolution steps
 * - TypeScript paths auto-generation (via _internal.generateTSConfig)
 * - Friendly error messages & config validation
 * - Default presets (@root, @src) for plug-and-play
 *
 * Benchmarks vs module-alias
 * - 3.2x faster alias resolution 10 aliases
 * - 8.7x faster 1000 aliases
 * - 60% lower memory usage under load v4
 * - Near-zero overhead when disabled
 *
 * Security:
 * - All alias targets are normalized and validated
 * - No eval(), no child_process, no fs write
 * - Path sanitization against "../", "~", null bytes
 *
 * ESLint Recommendation:
 * // .eslintrc.js
 * "settings": {
 *   "import/resolver": {
 *     "node": { "paths": ["."], "extensions": [".js"] }
 *   }
 * }
 *
 * Quickstart (small project)
 * 1. npm install pathlra-aliaser
 * 2. Add to package.json:
 *    "path_aliaser": { "@src": "src", "@root": "." }
 * 3. At top of main file: require('pathlra-aliaser')()
 * 4. Use: require('@src/utils')
 *
 * Visual Alias Mapping
 * Requested: "@src/utils/helper"
 * Matched alias: "@src" → resolves to "/project/src"
 * Final path: "/project/src/utils/helper"
 */

const path = require("path");
const moduleLib = require("module");
const fs = require("fs");
const { performance: performance } = require("perf_hooks");

// Platform-agnostic path separator handling
var pathSeparator = path.sep;
var separatorCode = pathSeparator.charCodeAt(0);
var forwardSlashCode = 47; // Forward slash code
var backSlashCode = 92; // Backslash code
var nullSeparator = "\0"; // Null separator for cache keys
var cacheMaxSize = 10000; // Max LRU cache size
var evictionBatchSize = Math.floor(cacheMaxSize * 0.1); // Eviction batch size
var STRATEGY_LINEAR = 0; // Strategy ID: linear scan
var STRATEGY_RADIX = 1; // Strategy ID: radix tree
let currentStrategy = STRATEGY_LINEAR; // Current active strategy

// Developer experience flags
let debugMode = false; // Debug/verbose mode
let hotReloadEnabled = false; // Hot-reload enabled
let minimalMode = false; // Minimal footprint mode (<10 aliases)

/**
 * Lightweight LRU cache with batch eviction
 * Optimized for high-frequency module resolution
 */
class LRUCache {
  constructor(max) {
    this.max = max;
    this.cacheMap = new Map(); // Key -> node
    this.head = null; // Head (most recently used)
    this.tail = null; // Tail (least recently used)
  }
  get(key) {
    const node = this.cacheMap.get(key);
    if (!node) return undefined;
    if (node !== this.head) {
      if (node.prev) node.prev.next = node.next;
      if (node.next) node.next.prev = node.prev;
      if (node === this.tail) this.tail = node.prev;
      node.prev = null;
      node.next = this.head;
      if (this.head) this.head.prev = node;
      this.head = node;
    }
    return node.value;
  }
  set(key, value) {
    let node = this.cacheMap.get(key);
    if (node) {
      node.value = value;
      this.get(key);
      return;
    }
    node = { key, value, prev: null, next: this.head };
    if (this.head) this.head.prev = node;
    this.head = node;
    if (!this.tail) this.tail = node;
    this.cacheMap.set(key, node);
    if (this.cacheMap.size > this.max) this.evict();
  }
  evict() {
    if (!this.tail) return;
    let currentNode = this.tail;
    for (let i = 0; i < evictionBatchSize && currentNode; i++) {
      this.cacheMap.delete(currentNode.key);
      currentNode = currentNode.prev;
    }
    if (currentNode) {
      currentNode.next = null;
      this.tail = currentNode;
    } else {
      this.head = null;
      this.tail = null;
    }
  }
  clear() {
    this.cacheMap.clear();
    this.head = null;
    this.tail = null;
  }
}

// Global resolution cache
const resolutionCache = new LRUCache(cacheMaxSize);

/**
 * Radix tree node for path prefix matching
 */
class RadixNode {
  constructor() {
    this.children = null;
    this.target = null;
    this.edge = "";
    this.isLeaf = false;
  }
}




/**
 * Radix tree for efficient prefix-based alias lookup
 */
class RadixTree {
  constructor() {
    this.root = new RadixNode();
  }

  insert(alias, target) {
    let node = this.root;
    let i = 0;
    const aliasLength = alias.length;

    while (i < aliasLength) {
      const currentChar = alias.charCodeAt(i);
      if (!node.children) node.children = Object.create(null);
      let child = node.children[currentChar];
      if (!child) {
        child = new RadixNode();
        child.edge = alias.slice(i);
        child.target = target;
        child.isLeaf = true;
        node.children[currentChar] = child;
        return;
      }

      const edgeData = child.edge;
      let j = 0;
      const edgeLength = edgeData.length;
      const remaining = aliasLength - i;
      while (j < edgeLength && j < remaining && edgeData.charCodeAt(j) === alias.charCodeAt(i + j)) j++;

      if (j === edgeLength) {
        i += edgeLength;
        node = child;
        continue;
      }

      if (j > 0) {
        const splitNode = new RadixNode();
        splitNode.edge = edgeData.slice(0, j);
        splitNode.children = Object.create(null);
        child.edge = edgeData.slice(j);
        const edgeSplitChar = edgeData.charCodeAt(j);
        splitNode.children[edgeSplitChar] = child;
        const newLeaf = new RadixNode();
        newLeaf.edge = alias.slice(i + j);
        newLeaf.target = target;
        newLeaf.isLeaf = true;
        const newSplitChar = alias.charCodeAt(i + j);
        splitNode.children[newSplitChar] = newLeaf;
        node.children[currentChar] = splitNode;
        return;
      }

      const branchNode = new RadixNode();
      branchNode.children = Object.create(null);
      const edgeFirstChar = edgeData.charCodeAt(0);
      branchNode.children[edgeFirstChar] = child;
      const newLeaf2 = new RadixNode();
      newLeaf2.edge = alias.slice(i);
      newLeaf2.target = target;
      newLeaf2.isLeaf = true;
      const newSplitChar2 = alias.charCodeAt(i);
      branchNode.children[newSplitChar2] = newLeaf2;
      node.children[currentChar] = branchNode;
      return;
    }
    node.target = target;
    node.isLeaf = true;
  }

  find(request) {
    let node = this.root;
    let lastMatch = null;
    let depth = 0;
    const requestLength = request.length;
    while (depth < requestLength && node) {
      if (node.isLeaf) {
        const nextChar = request.charCodeAt(depth);
        if (nextChar === forwardSlashCode || nextChar === backSlashCode || nextChar === separatorCode) {
          lastMatch = { alias: node.edge, target: node.target };
        }
      }
      if (!node.children) break;
      const currentDepthChar = request.charCodeAt(depth);
      const child = node.children[currentDepthChar];
      if (!child) break;
      const edgeData = child.edge;
      const edgeLength = edgeData.length;
      if (request.startsWith(edgeData, depth)) {
        depth += edgeLength;
        if (child.isLeaf && depth === requestLength) return { alias: edgeData, target: child.target };
        node = child;
        continue;
      }
      let k = 0;
      while (k < edgeLength && depth + k < requestLength && edgeData.charCodeAt(k) === request.charCodeAt(depth + k))
        k++;
      if (k === 0) break;
      if (
        child.isLeaf &&
        (depth + k === requestLength || [forwardSlashCode, backSlashCode, separatorCode].includes(request.charCodeAt(depth + k)))
      ) {
        return { alias: edgeData.slice(0, k), target: child.target };
      }
      break;
    }
    return lastMatch;
  }
}






// Global state
const customPathsSet = new Set(); // Custom paths
const aliasMap = new Map(); // Aliases
const seenAliases = new Set(); // For duplicate detection
let radixTree = null;
let sortedAliases = null;
let pathArray = [];
let hasAliases = false;
let aliasesChanged = false;
let pathsChanged = false;
let lastPkgPath = null;

// Patch Node.js module system
const Module = moduleLib.constructor.length > 1 ? moduleLib.constructor : moduleLib;
const originalNodeModulePaths = Module._nodeModulePaths;
const originalResolveFilename = Module._resolveFilename;

Module._nodeModulePaths = function (fromPath) {
  if (fromPath.includes(`${pathSeparator}node_modules${pathSeparator}`)) return originalNodeModulePaths.call(this, fromPath);
  const pathsList = originalNodeModulePaths.call(this, fromPath);
  return pathArray.length ? pathArray.concat(pathsList) : pathsList;
};

Module._resolveFilename = function (request, parent, isMain, options) {
  const parentPath = parent?.filename || "";
  const cacheKey = parentPath + nullSeparator + request;
  const cachedResult = resolutionCache.get(cacheKey);
  if (cachedResult !== undefined) {
    if (debugMode) console.log(`pathlra-aliaser CACHE HIT ${request} → ${cachedResult}`);
    return cachedResult;
  }

  let resolvedRequest = request;
  let matchResult = null;

  /**
   * ------------------------------------------------------------
   * Modified Version Notice
   * ------------------------------------------------------------
   * This file has been modified from the original "pathlra-aliaser"
   * library by hub-mgv
   *
   * Modifications made by [Mazarita Bot]
   * Year 2026
   *
   * Summary of changes
   * - Added support for underscore-based alias resolution
   *
   * These changes are distributed under the same MIT License.
   * ------------------------------------------------------------
   */
  if (!request.includes("/") && request.includes("_")) {
    // Added support for underscore-based alias resolution
    const parts = request.split("_");
    const aliasCandidate = "_" + parts[1];
    if (aliasMap.has(aliasCandidate)) {
      const rest = parts.slice(2).join("_");
      request = aliasCandidate + (rest ? "/" + rest : "");
    }
  }
  // MIT License

  if (hasAliases) {
    if (aliasesChanged) {
      optimizeStrategy();
      aliasesChanged = false;
    }

    if (currentStrategy === STRATEGY_LINEAR) {
      const requestLength = request.length;
      for (let i = 0; i < sortedAliases.length; i++) {
        const [alias, target] = sortedAliases[i];
        const aliasLength = alias.length;
        if (aliasLength > requestLength) continue;
        if (request.startsWith(alias)) {
          if (aliasLength === requestLength || [forwardSlashCode, backSlashCode, separatorCode].includes(request.charCodeAt(aliasLength))) {
            matchResult = { alias, target };
            break;
          }
        }
      }
    } else {
      matchResult = radixTree.find(request);
    }

    if (matchResult) {
      const { alias, target } = matchResult;
      const resolvedTarget = typeof target === "function" ? target(parentPath, request, alias) : target;
      if (typeof resolvedTarget !== "string") {
        throw new Error(
          "pathlra-aliaser Custom handler must return string path"
        );
      }
      // SECURITY: Validate target path
      if (!isValidTarget(resolvedTarget)) {
        throw new Error(`pathlra-aliaser Invalid alias target detected ${resolvedTarget}`);
      }
      const suffix = request.slice(alias.length);
      resolvedRequest = suffix ? resolvedTarget + (suffix.charCodeAt(0) === separatorCode ? suffix : pathSeparator + suffix) : resolvedTarget;
      if (debugMode)
        console.log(`pathlra-aliaser RESOLVED ${request} → ${resolvedRequest} (via ${alias})`);
    } else if (debugMode) {
      console.log(`pathlra-aliaser NO MATCH ${request}`);
    }
  }

  const result = originalResolveFilename.call(this, resolvedRequest, parent, isMain, options);
  resolutionCache.set(cacheKey, result);
  return result;
};

/**
 * Validate alias target to prevent path injection
 */
function isValidTarget(targetPath) {
  if (targetPath.includes("..")) return false;
  if (targetPath.includes("~")) return false;
  if (targetPath.includes("\0")) return false;
  try {
    path.normalize(targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Register single alias with duplicate warning
 */
function addAlias(alias, target) {
  if (seenAliases.has(alias)) {
    console.warn(
      `pathlra-aliaser WARNING Duplicate alias "${alias}" detected Overwriting`
    );
  } else {
    seenAliases.add(alias);
  }
  aliasMap.set(alias, target);
  hasAliases = true;
  aliasesChanged = true;
}

/**
 * Add custom module directory
 */
function addPath(directory) {
  const normalizedDir = path.normalize(directory);
  if (customPathsSet.has(normalizedDir)) return;
  customPathsSet.add(normalizedDir);
  pathArray = [...customPathsSet].sort((x, y) => y.length - x.length);
  pathsChanged = true;
  if (hotReloadEnabled) setImmediate(applyPathsToCache);
}

function applyPathsToCache() {
  if (!pathsChanged) return;
  const mainModule = require.main;
  if (mainModule && !mainModule._simulateRepl) updateModulePaths(mainModule);
  let parentModule = module.parent;
  const seenNodes = new Set();
  while (parentModule && !seenNodes.has(parentModule)) {
    seenNodes.add(parentModule);
    updateModulePaths(parentModule);
    parentModule = parentModule.parent;
  }
  pathsChanged = false;
}

function updateModulePaths(moduleData) {
  if (!moduleData.paths) return;
  for (const directory of customPathsSet) {
    if (!moduleData.paths.includes(directory)) moduleData.paths.unshift(directory);
  }
}

/**
 * Optimize based on alias count
 */
function optimizeStrategy() {
  const count = aliasMap.size;
  if (count === 0) {
    hasAliases = false;
    sortedAliases = null;
    radixTree = null;
    currentStrategy = STRATEGY_LINEAR;
    minimalMode = false;
    return;
  }

  minimalMode = count < 10;
  if (minimalMode) {
    // Reduce cache size in minimal mode
    resolutionCache.max = 1000;
    evictionBatchSize = 100;
  } else {
    resolutionCache.max = cacheMaxSize;
    evictionBatchSize = Math.floor(cacheMaxSize * 0.1);
  }

  if (count < 100) {
    currentStrategy = STRATEGY_LINEAR;
    sortedAliases = [...aliasMap.entries()].sort((x, y) => y[0].length - x[0].length);
    radixTree = null;
  } else {
    currentStrategy = STRATEGY_RADIX;
    buildRadixTree();
    sortedAliases = null;
  }
}

function buildRadixTree() {
  radixTree = new RadixTree();
  aliasMap.forEach((target, alias) => radixTree.insert(alias, target));
}

/**
 * Initialize from package.json or options
 */
function initialize(options = {}) {
  const startTime = performance.now();
  const basePath = getBasePath(options);
  const packageJson = loadPackageJson(basePath);
  lastPkgPath = path.join(basePath, "package.json");

  // Enable debug mode
  if (options.debug) debugMode = true;
  if (options.hotReload) hotReloadEnabled = true;

  // Auto-watch for changes in dev (hot-reload)
  if (hotReloadEnabled && lastPkgPath) {
    fs.watch(lastPkgPath, () => {
      console.log("pathlra-aliaser package.json changed. Reloading aliases...");
      reset();
      initialize({ base: basePath, debug: debugMode, hotReload: hotReloadEnabled });
    });
  }

  // Find config section
  const configKey = Object.keys(packageJson).find((k) => k.startsWith("path_aliaser"));
  const aliases = configKey ? packageJson[configKey] : {};

  // Apply default presets if none exist
  if (Object.keys(aliases).length === 0) {
    aliases["@root"] = ".";
    aliases["@src"] = "src";
    console.log(
      "pathlra-aliaser No aliases found. Using defaults: @root → ., @src → src"
    );
  }

  // Register aliases
  for (const [alias, target] of Object.entries(aliases)) {
    if (typeof target !== "string" && typeof target !== "function") {
      throw new Error(
        `pathlra-aliaser Invalid alias target for "${alias}". Must be string or function`
      );
    }
    const resolvedPath = target.startsWith("/") ? target : path.join(basePath, target);
    addAlias(alias, resolvedPath);
  }

  // Custom module directories
  const directories = packageJson._moduleDirectories || ["node_modules"];
  for (const directory of directories) {
    if (directory !== "node_modules") addPath(path.join(basePath, directory));
  }

  optimizeStrategy();
  applyPathsToCache();

  const duration = performance.now() - startTime;
  if (duration > 20) {
    console.warn(
      `pathlra-aliaser Init took ${duration.toFixed(1)}ms (optimized for ${
        aliasMap.size
      } aliases)`
    );
  }

  return {
    aliases: aliasMap.size,
    paths: customPathsSet.size,
    duration: duration,
    minimalMode: minimalMode,
  };
}

function getBasePath(options) {
  if (typeof options === "string") options = { base: options };
  if (options.base) return path.resolve(options.base.replace(/\/package\.json$/, ""));
  const candidates = [path.join(__dirname, "../.."), process.cwd()];
  for (const candidate of candidates) {
    try {
      fs.accessSync(path.join(candidate, "package.json"), fs.constants.R_OK);
      return candidate;
    } catch {}
  }
  throw new Error(`Failed to locate package.json in\n${candidates.join("\n")}`);
}

function loadPackageJson(basePath) {
  try {
    const packagePath = path.join(basePath, "package.json");
    return JSON.parse(fs.readFileSync(packagePath, "utf8"));
  } catch (error) {
    throw new Error(`Failed to load package.json: ${error.message}`);
  }
}

function reset() {
  resolutionCache.clear();
  customPathsSet.clear();
  aliasMap.clear();
  seenAliases.clear();
  pathArray = [];
  radixTree = null;
  sortedAliases = null;
  hasAliases = false;
  aliasesChanged = false;
  pathsChanged = false;
  debugMode = false;
  hotReloadEnabled = false;
  minimalMode = false;

  const mainModule = require.main;
  if (mainModule && !mainModule._simulateRepl) cleanModulePaths(mainModule);
  let parentModule = module.parent;
  const seenNodes = new Set();
  while (parentModule && !seenNodes.has(parentModule)) {
    seenNodes.add(parentModule);
    cleanModulePaths(parentModule);
    parentModule = parentModule.parent;
  }
  const pathsList = [...customPathsSet];
  for (const key of Object.keys(require.cache)) {
    if (pathsList.some((pathItem) => key.startsWith(pathItem))) delete require.cache[key];
  }
}

function cleanModulePaths(moduleData) {
  if (!moduleData.paths) return;
  moduleData.paths = moduleData.paths.filter((pathItem) => !customPathsSet.has(pathItem));
}

// Public API
module.exports = Object.assign(initialize, {
  addPath,
  addAlias,
  addAliases: (aliases) => {
    for (const [alias, target] of Object.entries(aliases)) addAlias(alias, target);
    aliasesChanged = true;
  },
  reset,
  _internal: {
    getStats: () => ({
      aliases: aliasMap.size,
      paths: customPathsSet.size,
      cacheSize: resolutionCache.cacheMap.size,
      strategy: currentStrategy === STRATEGY_LINEAR ? "LINEAR" : "RADIX",
      minimalMode: minimalMode,
      hotReload: hotReloadEnabled,
      debug: debugMode,
      memory: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2) + " MB",
    }),
    forceStrategy: (strategy) => {
      currentStrategy = strategy;
      if (strategy === STRATEGY_RADIX) buildRadixTree();
    },
    clearCache: () => resolutionCache.clear(),
    /**
     * Generate tsconfig.json paths for TypeScript integration
     * Usage: fs.writeFileSync('tsconfig.json', JSON.stringify(generateTSConfig(), null, 2))
     */
    generateTSConfig: () => {
      const compilerOptions = {
        baseUrl: ".",
        paths: {},
      };
      aliasMap.forEach((target, alias) => {
        let relativePath = path.relative(process.cwd(), target);
        if (!relativePath.startsWith(".")) relativePath = "./" + relativePath;
        compilerOptions.paths[alias + "/*"] = [relativePath + "/*"];
        compilerOptions.paths[alias] = [relativePath];
      });
      return { compilerOptions };
    },
  },
});
