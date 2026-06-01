import globals from "globals";

// Correctness-focused rules (no stylistic noise). The point of this config is to
// catch typos, undefined references, redeclarations and dead code — the class of
// bug that has no test suite to catch it.
const correctness = {
  "no-undef": "error",
  "no-unused-vars": ["warn", { args: "none", varsIgnorePattern: "^_" }],
  "no-dupe-keys": "error",
  "no-dupe-args": "error",
  "no-duplicate-case": "error",
  "no-unreachable": "warn",
  "no-cond-assign": "error",
  "no-constant-condition": ["error", { checkLoops: false }],
  "use-isnan": "error",
  "valid-typeof": "error",
  "no-self-assign": "error",
};

// The renderer is loaded as CLASSIC scripts (i18n.js + lib/*.js + renderer.js) that
// share one global scope — no ES modules. So every top-level function/var defined in
// one file is a global usable from the others. We declare them here so no-undef only
// flags REAL typos. Regenerate this list after adding/removing top-level declarations:
//   node -e "see scripts note"
const rendererShared = {
    CLEAN_RE: "writable",
    ICONS: "writable",
    QUALITY_REGEX: "writable",
    TRANSLATIONS: "writable",
    _lang: "writable",
    applySetupPlayer: "writable",
    applyTranslations: "writable",
    bindUI: "writable",
    browsePlayer: "writable",
    castTargetId: "writable",
    cleanTitle: "writable",
    closeAbout: "writable",
    closeCastModal: "writable",
    closeDetailView: "writable",
    closeFilePicker: "writable",
    closeHistory: "writable",
    closePlayerSetup: "writable",
    closeSettings: "writable",
    createCard: "writable",
    createLibCard: "writable",
    discoverCache: "writable",
    discoverCat: "writable",
    doAdd: "writable",
    esc: "writable",
    extractQuality: "writable",
    fetchAndRenderDetailStreams: "writable",
    fetchAndRenderTorrentioStreams: "writable",
    filePickerTorrentId: "writable",
    fmt: "writable",
    fmtDate: "writable",
    fmtETA: "writable",
    fmtSize: "writable",
    fmtTime: "writable",
    getLang: "writable",
    handleAdd: "writable",
    handleSearch: "writable",
    handleTorrentioSearch: "writable",
    hideClipboardBanner: "writable",
    init: "writable",
    initCardQualityOverlay: "writable",
    initWinCtrl: "writable",
    isInputActive: "writable",
    isResumable: "writable",
    isSeries: "writable",
    libSort: "writable",
    libTypeFilter: "writable",
    loadDiscover: "writable",
    openAbout: "writable",
    openCastPicker: "writable",
    openDetailView: "writable",
    openFilePicker: "writable",
    openHistory: "writable",
    openSettings: "writable",
    pendingClipboardMagnet: "writable",
    pendingTorrents: "writable",
    pickBestStream: "writable",
    play: "writable",
    playLocal: "writable",
    players: "writable",
    populateSettings: "writable",
    remove: "writable",
    renderDiscoverGrid: "writable",
    renderDiscoverSkeleton: "writable",
    renderHistory: "writable",
    renderList: "writable",
    renderPlayerSetupList: "writable",
    renderQualityShortcuts: "writable",
    renderResult: "writable",
    renderStreamRows: "writable",
    renderTorrentioEpPicker: "writable",
    renderTorrentioTitles: "writable",
    rescan: "writable",
    saveSettings: "writable",
    searchDebounceTimer: "writable",
    searchFilters: "writable",
    seedsClass: "writable",
    selectTorrentioTitle: "writable",
    settings: "writable",
    setupDetailEpPicker: "writable",
    showClipboardBanner: "writable",
    showDisclaimer: "writable",
    showPlayerSetup: "writable",
    speedGraph: "writable",
    stopSeed: "writable",
    streamCache: "writable",
    t: "writable",
    toast: "writable",
    toastTimer: "writable",
    torrentioBackFn: "writable",
    torrentioCurrentItem: "writable",
    torrentioGoBack: "writable",
    torrentioTitles: "writable",
    torrents: "writable",
    updateCard: "writable",
    updateGlobalStats: "writable",
    watchFraction: "writable",
};

export default [
  { ignores: ["dist/**", "node_modules/**", "src/renderer/css/**"] },

  // Main process — ESM, Node
  {
    files: ["src/*.js", "scripts/**/*.mjs", "eslint.config.js"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: { ...globals.node } },
    rules: correctness,
  },

  // Preload — CommonJS (mandatory .cjs)
  {
    files: ["src/preload.cjs"],
    languageOptions: { ecmaVersion: 2024, sourceType: "commonjs", globals: { ...globals.node } },
    rules: correctness,
  },

  // Renderer — classic browser scripts sharing a global scope
  {
    files: ["src/renderer/**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "script",
      globals: { ...globals.browser, ...rendererShared },
    },
    rules: {
      ...correctness,
      "no-redeclare": ["error", { builtinGlobals: false }],
      // Top-level functions/state ARE the shared cross-file globals — only flag
      // genuinely-unused LOCALS inside functions, not the global scope.
      "no-unused-vars": ["warn", { vars: "local", args: "none", varsIgnorePattern: "^_" }],
    },
  },
];
