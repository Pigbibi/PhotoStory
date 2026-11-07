import {languages} from './vocabulary.mjs';

// The processor needs the same set of codes, so it comes from the shared vocabulary.
export const LANGUAGES = languages;

function language(value) {
 const chosen=value||'en';
 if(typeof chosen!=='string'||!Object.hasOwn(LANGUAGES,chosen))throw new Error('invalid_language');
 return chosen;
}
export function captionLanguage(env) {
 return language(env.AI_CAPTION_LANGUAGE);
}
export function jobLanguages(env) {
 return {captionLanguage:captionLanguage(env),editorLanguage:language(env.AI_EDITOR_LANGUAGE)};
}
