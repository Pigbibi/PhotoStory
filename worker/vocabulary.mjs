// The processor is a separate process written in Python: it reads
// contracts/vocabulary.json directly. The worker cannot read a file at runtime,
// so it restates that data here and tests/contracts.test.mjs fails the moment
// the two disagree. Change the JSON and this module together.
export const failureCodes = [
  'folder_limit',
  'folder_not_found',
  'gateway_failed',
  'gateway_not_configured',
  'gateway_timeout',
  'group_contract',
  'history_match_contract',
  'history_not_complete',
  'https_required',
  'image_too_large',
  'invalid_graph_origin',
  'page_limit',
  'photo_limit',
  'redirect_blocked',
  'response_too_large',
  'screen_contract',
  'setup_required',
  'thumbnail_missing',
  'thumbnail_origin',
  'translation_contract',
  'unknown',
];

export const failureStages = ['inventory', 'thumbnail', 'ai_gateway', 'completion'];

export const feedbackCategories = [
  'not_scenery', 'wrong_place_time', 'incoherent', 'weak_cover',
  'inaccurate_caption', 'ordinary', 'other',
];

export const languages = {
  en: 'English',
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  ja: '日本語',
  ko: '한국어',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  pt: 'Português',
  it: 'Italiano',
  ru: 'Русский',
  ar: 'العربية',
  hi: 'हिन्दी',
};

export const promptLanguages = {
  en: 'English',
  'zh-CN': 'Simplified Chinese',
  'zh-TW': 'Traditional Chinese',
  ja: 'Japanese',
  ko: 'Korean',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  pt: 'Portuguese',
  it: 'Italian',
  ru: 'Russian',
  ar: 'Arabic',
  hi: 'Hindi',
};

export const aspects = ['4:5', '1:1', '3:2'];

export const aspectByOrientation = { landscape: '3:2', portrait: '4:5', square: '1:1' };

export const matchAlgorithm = 'dhash-v1';

export const draftTextLimits = { title: 160, caption: 1800, hashtags: 350, reason: 600, alt: 300 };

export const draftPhotoLimit = 8;

export const idPattern = '^[A-Za-z0-9_-]{1,128}$';
export const instagramIdPattern = '^\\d{1,32}$';

export const failureCodeSet = new Set(failureCodes);
export const failureStageSet = new Set(failureStages);
export const ID_PATTERN = new RegExp(idPattern);
export const INSTAGRAM_ID_PATTERN = new RegExp(instagramIdPattern);
