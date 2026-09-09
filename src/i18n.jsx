import React,{createContext,useContext,useState,useEffect,useMemo} from 'react';
import {LANGUAGES,localeOrDefault,direction,translate} from './i18n-core.mjs';
const files=import.meta.glob('./locales/*.json',{eager:true,import:'default'});
const catalogs=Object.fromEntries(Object.entries(files).map(([path,value])=>[path.split('/').at(-1).replace('.json',''),value]));
const Context=createContext(null);
export function I18nProvider({children}) {
 const [locale,setLocale]=useState(()=>{try{return localeOrDefault(localStorage.getItem('photostory-language'));}catch{return 'en';}});
 useEffect(()=>{document.documentElement.lang=locale;document.documentElement.dir=direction(locale);try{localStorage.setItem('photostory-language',locale);}catch{}},[locale]);
 const value=useMemo(()=>({locale,setLocale,t:(key,values)=>translate(catalogs,locale,key,values),
  date:value=>new Date(value).toLocaleString(locale,{timeZone:'Asia/Shanghai',hour12:false}),
  weekday:i=>new Intl.DateTimeFormat(locale,{weekday:'long',timeZone:'UTC'}).format(new Date(Date.UTC(2026,0,4+i))),
 }),[locale]);
 return <Context.Provider value={value}>{children}</Context.Provider>;
}
export const useI18n=()=>useContext(Context);
export function LanguageSwitcher(){
 const {locale,setLocale}=useI18n();
 return <select className="language-switch" aria-label="Language" dir="ltr" value={locale} onChange={e=>setLocale(e.target.value)}>{Object.entries(LANGUAGES).map(([code,name])=><option key={code} value={code} lang={code}>{name}</option>)}</select>;
}
