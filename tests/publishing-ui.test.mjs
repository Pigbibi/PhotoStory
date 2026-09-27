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
test('owner-approved draft explains missing schedule and the next available window',async t=>{
 const vite=await createServer({configFile:false,server:{middlewareMode:true,hmr:false}});t.after(()=>vite.close());
 const {Publishing,nextOwnerWindow}=await vite.ssrLoadModule('/src/Publishing.jsx');
 const {I18nProvider}=await vite.ssrLoadModule('/src/i18n.jsx');
 const draft={id:'fixture',version:1,approvalSource:'owner_scheduled_v1',publication:null};
 const render=schedule=>renderToStaticMarkup(React.createElement(I18nProvider,null,React.createElement(Publishing,{draft,onChange:()=>{},schedule,onSettings:()=>{}})));
 assert.match(render({publishMode:'automatic',reviewMode:'strict_auto',weekday:null,hour:null}),/Owner scheduling is not configured/);
 assert.match(render({publishMode:'automatic',reviewMode:'strict_auto',weekday:null,hour:null}),/Set publishing schedule/);
 assert.match(render({publishMode:'automatic',reviewMode:'strict_auto',weekday:2,hour:10}),/Next available publishing window/);
 assert.equal(nextOwnerWindow({weekday:2,hour:10},Date.parse('2026-09-29T02:00:00Z')),Date.parse('2026-10-06T02:00:00Z'));
 assert.equal(nextOwnerWindow({adaptive:true,weekday:null,hour:19},Date.parse('2026-09-27T10:00:00Z')),Date.parse('2026-09-27T11:00:00Z'));
 assert.match(render({publishMode:'automatic',reviewMode:'strict_auto',adaptive:true,weekday:null,hour:19}),/actual interval follows the approved backlog/i);
});
