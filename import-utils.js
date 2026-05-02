(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
    return;
  }

  root.VowCueImportUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'm4a', 'aac', 'aif', 'aiff', 'flac']);
  const CONTENT_TYPE_EXTENSIONS = {
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/wav': 'wav',
    'audio/wave': 'wav',
    'audio/x-wav': 'wav',
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/aac': 'aac',
    'audio/x-aac': 'aac',
    'audio/aiff': 'aiff',
    'audio/x-aiff': 'aiff',
    'audio/flac': 'flac',
    'audio/x-flac': 'flac',
  };

  function slugifyLabel(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function parseUrl(input) {
    try {
      return new URL(input);
    } catch {
      return null;
    }
  }

  function extensionFromPathname(pathname) {
    const match = String(pathname || '').match(/\.([a-z0-9]+)$/i);
    return match ? match[1].toLowerCase() : '';
  }

  function isLikelyDirectAudioUrl(input) {
    const parsed = parseUrl(input);
    if (!parsed || !/^https?:$/.test(parsed.protocol)) return false;
    return AUDIO_EXTENSIONS.has(extensionFromPathname(parsed.pathname));
  }

  function contentTypeToExtension(contentType) {
    const normalized = String(contentType || '')
      .toLowerCase()
      .split(';')[0]
      .trim();
    return CONTENT_TYPE_EXTENSIONS[normalized] || 'bin';
  }

  function fileNameFromUrl(input) {
    const parsed = parseUrl(input);
    if (!parsed) return '';
    const basename = parsed.pathname.split('/').filter(Boolean).pop() || '';
    return basename.trim();
  }

  function buildImportedFileName({ cueName = '', eventName = '', sourceUrl = '', contentType = '' } = {}) {
    const directName = fileNameFromUrl(sourceUrl);
    const ext = extensionFromPathname(directName) || contentTypeToExtension(contentType);
    const label = [slugifyLabel(eventName), slugifyLabel(cueName)].filter(Boolean).join('-');

    if (label) {
      return `${label}.${ext}`;
    }

    if (directName) {
      return directName;
    }

    return `imported-audio.${ext}`;
  }

  return {
    slugifyLabel,
    isLikelyDirectAudioUrl,
    contentTypeToExtension,
    buildImportedFileName,
  };
});
