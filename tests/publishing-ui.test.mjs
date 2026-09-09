import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createServer} from 'vite';
test('publishing panel renders the final-review entry point with the production JSX transform',async t=>{
 const vite=await createServer({configFile:false,server:{middlewareMode:true,hmr:false}});t.after(()=>vite.close());
 const {Publishing}=await vite.ssrLoadModule('/src/Publishing.jsx');
 const {I18nProvider}=await vite.ssrLoadModule('/src/i18n.jsx');
 const html=renderToStaticMarkup(React.createElement(I18nProvider,null,React.createElement(Publishing,{draft:{id:'fixture',version:1,publication:null},onChange:()=>{}})));
 assert.match(html,/Prepare Instagram post/);assert.ok(!html.includes('Publish to @'));
});
