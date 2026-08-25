/* Trend source direct scan fix */
(function(global){
"use strict";
const LAST_N=6;
const clean=v=>String(v??"").trim();
function pickTrendFile(files){
 return (files||[]).find(f=>{
  const n=clean(f.name).toLowerCase();
  return n==="trend.xlsx" || n==="trend.xlsm";
 })||null;
}
function findHeaderRow(grid){
 const h={code:["outlet code","site code","outlet","code"],name:["outlet name","name"],date:["date","visit date"],score:["score","total score","total","visit score"]};
 for(let r=0;r<Math.min(grid.length,15);r++){
  const row=(grid[r]||[]).map(x=>clean(x).toLowerCase());
  const at={}; Object.keys(h).forEach(k=>at[k]=row.findIndex(x=>h[k].includes(x)));
  if(at.code>=0&&at.date>=0&&at.score>=0)return {row:r,at};
 }
 return null;
}
function parseWorkbook(buffer){
 const wb=global.XLSX.read(buffer,{type:"array",cellDates:true});
 for(const s of wb.SheetNames){
  const grid=global.XLSX.utils.sheet_to_json(wb.Sheets[s],{header:1,defval:""});
  const found=findHeaderRow(grid); if(!found)continue;
  const outlets=new Map();
  grid.slice(found.row+1).forEach(row=>{
   const code=clean(row[found.at.code]).toUpperCase();
   const score=Number(row[found.at.score]);
   const date=clean(row[found.at.date]);
   if(!code||!date||!Number.isFinite(score))return;
   const item=outlets.get(code)||{name:"",visits:[]};
   item.visits.push({date,score}); outlets.set(code,item);
  });
  outlets.forEach(v=>{v.visits=v.visits.slice(-LAST_N)});
  if(outlets.size)return {outlets,sheet:s};
 }
 throw new Error("No Trend columns found.");
}
global.TrendSource={LAST_N,pickTrendFile,parseWorkbook,async fromDrive(drive){const files=await drive.listFolderFiles();const f=pickTrendFile(files);if(!f)return null;return {...parseWorkbook(await drive.downloadFile(f)),fileName:f.name};},async fromFile(file){return {...parseWorkbook(await file.arrayBuffer()),fileName:file.name};}};
})(typeof window!=="undefined"?window:globalThis);