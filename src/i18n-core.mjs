import {LANGUAGES} from '../worker/languages.mjs';
export {LANGUAGES};
export const localeOrDefault = value => Object.hasOwn(LANGUAGES,value)?value:'en';
export const direction = locale => locale==='ar'?'rtl':'ltr';
export function translate(catalogs,locale,key,values={}) {
 const template=catalogs[localeOrDefault(locale)]?.[key]??catalogs.en?.[key]??key;
 return String(template??'').replace(/\{(\w+)\}/g,(whole,k)=>Object.hasOwn(values,k)?String(values[k]):whole);
}

// Translations are display metadata; captions and approval payloads stay intact.
export function localizedDraftText(draft,field,locale) {
 return draft.translations?.[localeOrDefault(locale)]?.[field] || draft[field];
}
