export const LANGUAGES = {
 en:'English','zh-CN':'简体中文','zh-TW':'繁體中文',ja:'日本語',ko:'한국어',es:'Español',fr:'Français',de:'Deutsch',pt:'Português',it:'Italiano',ru:'Русский',ar:'العربية',hi:'हिन्दी',
};
export function captionLanguage(env) {
 const value=env.AI_CAPTION_LANGUAGE||'en';
 if(typeof value!=='string'||!Object.hasOwn(LANGUAGES,value))throw new Error('invalid_language');
 return value;
}
export function jobLanguages(env) {
 const editor=env.AI_EDITOR_LANGUAGE||'en';
 if(typeof editor!=='string'||!Object.hasOwn(LANGUAGES,editor))throw new Error('invalid_language');
 return {captionLanguage:captionLanguage(env),editorLanguage:editor};
}
