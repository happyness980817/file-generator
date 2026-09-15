#!/usr/bin/env node
'use strict';

/**
 * K-브랜드 HWPX 생성기 — Node.js, API 호출/한글 설치 없이 파일 생성.
 * 원본 ZIP → XML AST → 지정 셀 입력 → ZIP 재생성 → 재열기 검증.
 * 첨부된 특정 양식 2종 전용. 현재 상품 1개, 국가 최대 3개, 공장 최대 4개.
 * 사진 자동 삽입/여러 상품 별지/페이지 렌더러는 이 버전에 포함하지 않습니다.
 * 확인되지 않은 필수값은 '확인 필요', 결과는 항상 검토용으로 표시합니다.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const JSZip = require('jszip');
const { xml2js, js2xml } = require('xml-js');

const EXPECTED_HASH = {
  application: '53c61c99f5daffa8840b5af1c3aa5a998d9a8fb6df738b8ed55b19de975857c8',
  plan: 'ca22b89b730dc58248ac5f1bdf24e17b9ba33e781ce4410e7b6f27b236541e82',
};
const children = (node, name) => (node.elements || []).filter(e => e.type === 'element' && (!name || e.name === name));
function* walk(node) { yield node; for (const e of node.elements || []) yield* walk(e); }
const all = (node, name) => [...walk(node)].filter(e => e.type === 'element' && e.name === name);
const clone = obj => JSON.parse(JSON.stringify(obj));
const element = (name, attributes = {}, elements = []) => ({ type: 'element', name, attributes, elements });
const textNode = text => ({ type: 'text', text });
const textOf = node => [...walk(node)].filter(e => e.type === 'text').map(e => e.text).join('');
const documentText = doc => all(doc, 'hp:p').map(p => children(p, 'hp:run').flatMap(r => children(r, 'hp:t')).map(textOf).join('')).join('\n');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const parse = xml => {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('DOCTYPE/ENTITY 문서는 지원하지 않습니다.');
  return xml2js(xml, { compact: false, captureSpacesBetweenElements: true });
};
const serialize = doc => js2xml(doc, { compact: false, spaces: 0 });

function ensure(condition, message) { if (!condition) throw new Error(message); }
function stringValue(value, label, max = 3000) {
  ensure(typeof value === 'string' || typeof value === 'number', `${label}: 문자열 또는 숫자가 필요합니다.`);
  const text = String(value).trim().replace(/\r\n?/g, '\n');
  ensure(text.length <= max, `${label}: ${max}자 한도를 초과했습니다. 내용을 나누어 주세요.`);
  ensure(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text), `${label}: XML에 쓸 수 없는 제어문자입니다.`);
  return text;
}
function validateInput(data) {
  ensure(data && typeof data === 'object' && !Array.isArray(data), 'JSON 객체가 필요합니다.');
  ensure(data.company && typeof data.company === 'object' && !Array.isArray(data.company), 'company 객체가 필요합니다.');
  ensure(typeof data.company.nameKo === 'string' && data.company.nameKo.trim(), 'company.nameKo가 필요합니다.');
  for (const name of ['contact', 'manager', 'provider', 'plan']) {
    ensure(data[name] == null || (typeof data[name] === 'object' && !Array.isArray(data[name])), `${name}: 객체여야 합니다.`);
  }
  ensure(Array.isArray(data.products) && data.products.length === 1, '이 버전은 상품 1개만 지원합니다. 여러 상품은 자동으로 누락시키지 않고 중단합니다.');
  const product = data.products[0];
  ensure(product && typeof product === 'object' && !Array.isArray(product), 'products[0]: 객체여야 합니다.');
  for (const [key, max] of [['countries', 3], ['factories', 4]]) {
    ensure(product[key] == null || (Array.isArray(product[key]) && product[key].length <= max), `${key}: 최대 ${max}개까지 지원합니다.`);
    for (const row of product[key] || []) ensure(row && typeof row === 'object' && !Array.isArray(row), `${key}: 각 행은 객체여야 합니다.`);
  }
  ensure(!product.frontImage && !product.backImage && !product.images, '이 버전은 사진 자동 삽입을 지원하지 않습니다. 사진 입력을 무시하지 않고 중단합니다.');
  const date = data.applicationDate;
  if (date != null && date !== '') {
    ensure(typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && new Date(date).toISOString().slice(0,10) === date, 'applicationDate: 실제 날짜 YYYY-MM-DD가 필요합니다.');
  }
}

async function loadTemplate(filename, kind) {
  const bytes = await fs.readFile(filename);
  ensure(sha(bytes) === EXPECTED_HASH[kind], `${kind}: 원본 양식이 다릅니다. 잘못된 칸에 쓰지 않도록 중단합니다. 새 양식의 셀 매핑과 해시를 다시 검증해 주세요.`);
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  ensure(await zip.file('mimetype').async('string') === 'application/hwp+zip', 'HWPX mimetype이 아닙니다.');
  const doc = parse(await zip.file('Contents/section0.xml').async('string'));
  const header = parse(await zip.file('Contents/header.xml').async('string'));
  const root = all(doc, 'hs:sec')[0];
  const tables = all(root, 'hp:tbl');
  ensure(tables.length === (kind === 'application' ? 5 : 3), `${kind}: 표 개수가 예상과 다릅니다.`);
  return { bytes, zip, doc, header, root, tables, kind, updates: [], warnings: [], written: [] };
}

function needed(ctx, value, label, max) {
  if (value == null || value === '') { ctx.warnings.push(`${label}: 확인 필요`); return '확인 필요'; }
  const normalized = stringValue(value, label, max);
  if (!normalized) { ctx.warnings.push(`${label}: 확인 필요`); return '확인 필요'; }
  return normalized;
}
function cellAt(ctx, t, row, col) {
  const table = ctx.tables[t];
  ensure(table, `table ${t} 없음`);
  const matches = children(table, 'hp:tr').flatMap(r => children(r, 'hp:tc')).filter(cell => {
    const addr = children(cell, 'hp:cellAddr')[0]?.attributes;
    return Number(addr?.rowAddr) === row && Number(addr?.colAddr) === col;
  });
  ensure(matches.length === 1, `셀 (${t},${row},${col})을 유일하게 찾지 못했습니다.`);
  return matches[0];
}

// 빈 셀에는 hp:t가 아예 없으므로, 스타일/문단 속성을 가져와 새 run/t를 만듭니다.
// XML 문자열 치환을 하지 않아 &, <, > 등도 XML serializer가 이스케이프합니다.
function setCell(ctx, t, row, col, value, { charStyle, keepParagraphs = false } = {}) {
  const text = stringValue(value, `셀 ${t}/${row}/${col}`);
  const cell = cellAt(ctx, t, row, col);
  const list = children(cell, 'hp:subList')[0];
  const oldParagraph = children(list, 'hp:p')[0];
  ensure(oldParagraph, '셀 문단이 없습니다.');
  ensure(!all(list, 'hp:tbl').length && !all(list, 'hp:pic').length, '중첩 표/사진이 있는 셀은 덮어쓰지 않습니다.');
  const style = charStyle || (ctx.kind === 'application' ? '8' : '9');
  ensure(all(ctx.header, 'hh:charPr').some(e => e.attributes.id === style), `글자 스타일 ${style} 없음`);
  const paragraphs = text.split('\n').map((line, i) => element('hp:p', {
    ...oldParagraph.attributes, pageBreak: '0', columnBreak: '0',
  }, [element('hp:run', { charPrIDRef: style }, [element('hp:t', {}, [textNode(line)])])]));
  if (keepParagraphs) {
    // 사용처 없음: 의도치 않은 원본 안내문 혼입 방지를 위해 명시적으로 금지합니다.
    throw new Error('keepParagraphs 옵션은 지원하지 않습니다.');
  }
  list.elements = paragraphs;
  ctx.updates.push({ table: t, row, col, text });
  ctx.written.push(text);
}

function setRootParagraph(ctx, predicate, text) {
  const candidates = children(ctx.root, 'hp:p').filter(p => !all(p, 'hp:tbl').length && predicate(textOf(p)));
  ensure(candidates.length === 1, `본문 문단 매칭 실패: ${text.slice(0,45)}`);
  const p = candidates[0];
  const runs = children(p, 'hp:run');
  const charStyle = runs.find(r => children(r, 'hp:t').length)?.attributes.charPrIDRef || runs[0].attributes.charPrIDRef;
  // secPr/colPr가 있는 첫 문단도 유지합니다. 텍스트만 지우고 구조 컨트롤은 보존합니다.
  for (const r of runs) r.elements = (r.elements || []).filter(e => e.name !== 'hp:t');
  p.elements = (p.elements || []).filter(e => e.name !== 'hp:linesegarray');
  p.elements.push(element('hp:run', { charPrIDRef: charStyle }, [element('hp:t', {}, [textNode(text)])]));
  ctx.written.push(text);
}

function choices(ctx, values, selected, label) {
  if (selected == null || selected === '') ctx.warnings.push(`${label}: 선택 확인 필요`);
  else ensure(values.includes(selected), `${label}: 허용값은 ${values.join(', ')}입니다.`);
  return values.map(v => `${v === selected ? '☑' : '☐'} ${v}`).join('  ') + (selected ? '' : '  (확인 필요)');
}
function fillApplication(ctx, data) {
  const c = data.company, a = data.contact || {}, m = data.manager || {}, provider = data.provider || {};
  const pairs = [
    [0,2,c.nameKo,'기업명(국문)'], [0,5,c.nameEn,'기업명(영문)'], [1,2,c.registrationNumber,'사업자번호'],
    [1,5,c.representative,'대표자'], [2,2,c.address,'주소'], [4,2,c.department,'담당부서'],
    [5,2,a.name,'담당자'], [5,5,a.phone,'담당자 연락처'], [6,2,a.email,'담당자 이메일'],
    [7,2,m.name,'부서장'], [7,5,m.phone,'부서장 연락처'], [8,2,m.email,'부서장 이메일'],
  ];
  for (const [r,col,val,label] of pairs) setCell(ctx,0,r,col,needed(ctx,val,label,500));
  setCell(ctx,0,3,2,choices(ctx,['중소기업','중견기업','대기업'],c.category,'기업구분'));
  setCell(ctx,0,10,2,choices(ctx,['라벨','맞춤제작'],data.projectType,'사업과제'));
  setCell(ctx,0,11,3,needed(ctx,provider.name,'희망 수행업체'));
  setCell(ctx,0,12,3,`${needed(ctx,provider.contact,'수행업체 담당자')} / ${needed(ctx,provider.phone,'수행업체 연락처')}`);
  // r9c0 개인정보 동의는 절대 자동 체크하지 않습니다.
  const p = data.products[0];
  const countries = p.countries?.length ? p.countries : [{}];
  const countryNames = countries.map(x => needed(ctx,x.country,'사용국가')).join(', ');
  const scale = needed(ctx,p.exportScale,'수출규모(단위·기간 포함)');
  for (const [col,val,label] of [[1,p.brandKo,'브랜드 국문'],[2,p.nameKo,'상품 국문']]) setCell(ctx,1,1,col,needed(ctx,val,label));
  setCell(ctx,1,1,3,countryNames); setCell(ctx,1,1,4,scale); setCell(ctx,1,6,4,scale);
  for (const [r,col,val,label] of [
    [0,1,p.brandKo,'브랜드 국문'],[0,3,p.brandEn,'브랜드 영문'],[1,1,p.nameKo,'상품 국문'],
    [1,3,p.nameEn,'상품 영문'],[2,1,p.category,'상품분류'],[5,1,p.certifications,'보유인증'],[6,1,p.trademarks,'상표현황']
  ]) setCell(ctx,2,r,col,needed(ctx,val,label));
  setCell(ctx,2,3,1,'상품 전면·후면 사진 첨부 필요');
  ctx.warnings.push('사진 자동 삽입 미구현: 한글에서 상품 전면·후면 사진을 추가해야 합니다.');
  setCell(ctx,2,4,1,choices(ctx,['유','무'],p.certificationHeld,'인증 보유 여부'));
  setCell(ctx,3,0,1,choices(ctx,['국내생산','해외생산','국내/해외 병행생산'],p.productionLocation,'생산지'));
  setCell(ctx,3,1,1,choices(ctx,['자체생산','위탁생산(OEM/ODM)','자체/위탁 병행생산'],p.productionType,'생산형태'));
  const factories = p.factories?.length ? p.factories : [{}];
  factories.forEach((f,i) => {
    setCell(ctx,3,3+i,1,String(i+1));
    setCell(ctx,3,3+i,2,needed(ctx,f.country,'공장 제조국'));
    setCell(ctx,3,3+i,3,needed(ctx,f.productionType,'공장 생산형태'));
  });
  countries.forEach((n,i) => {
    [n.country,p.brandKo,p.nameKo].forEach((v,col)=>setCell(ctx,4,i+1,col,needed(ctx,v,['사용국가','브랜드','상품'][col])));
    setCell(ctx,4,i+1,3,choices(ctx,['등록완료','출원중','미출원'],n.trademarkStatus,'국가별 상표상태'));
    setCell(ctx,4,i+1,4,needed(ctx,n.trademarkNumberOrReason,'상표번호/미출원 사유'));
    setCell(ctx,4,i+1,5,needed(ctx,n.quantity,'부착 예정수량'));
    setCell(ctx,4,i+1,6,choices(ctx,['라벨','맞춤제작'],n.method,'국가별 사용방식'));
  });
  setRootParagraph(ctx,s=>s.startsWith('[붙임1-1]'),`[붙임1-1] 상품별 세부정보(${needed(ctx,p.nameKo,'상품명')})`);
  fillFooter(ctx,data);
}
function fillPlan(ctx,data) {
  const p = data.plan || {};
  const mapping = [[0,0,1,'counterfeitRisk','위조 피해·우려'],[0,1,1,'ipDefense','해외 IP·방어역량'],
    [1,0,1,'countries','활용국가'],[1,2,1,'channelPlan','활용채널 상세'],[1,3,1,'marketing','수출 마케팅 전략'],
    [1,4,1,'expectedEffects','기대효과'],[2,1,1,'improvement','개선계획']];
  for (const [t,r,c,key,label] of mapping) setCell(ctx,t,r,c,needed(ctx,p[key],label));
  const allowed = ['제품','포장','온라인몰','홈페이지/SNS','전시·박람회','기타'];
  const selected = p.channels || [];
  ensure(Array.isArray(selected) && selected.every(x=>allowed.includes(x)), 'plan.channels에 잘못된 활용채널이 있습니다.');
  setCell(ctx,1,1,1,allowed.map(v=>`${selected.includes(v)?'☑':'☐'} ${v}`).join('  ') + (selected.length?'':' (확인 필요)'));
  if (!selected.length) ctx.warnings.push('활용채널: 선택 확인 필요');
  setCell(ctx,2,0,1,'타사의 선행 IP 무단침해/카피 분쟁 요소가 있었습니까?\n'+choices(ctx,['없음','있음'],p.ipHistory,'분쟁 이력'));
  // 회색 안내 문단은 제출문안과 섞지 않고 검토용 상태로 교체합니다.
  setRootParagraph(ctx,s=>s.includes('회색 안내문은'), '검토용 초안 · 제안 문안 및 확인 필요 항목은 고객사 확인 후 확정');
  fillFooter(ctx,data);
}
function fillFooter(ctx,data) {
  const c=data.company;
  setRootParagraph(ctx,s=>s.startsWith(ctx.kind==='application'?'[붙임1]':'[붙임2]'),
    ctx.kind==='application'?'[검토용] 사용신청서 · 입력자료 미검증':'[검토용] 활용계획서 · 고객사 확인 전');
  setRootParagraph(ctx,s=>s.includes('신청기업명 :'),`               신청기업명 : ${needed(ctx,c.nameKo,'기업명')}`);
  setRootParagraph(ctx,s=>s.includes('대  표  자 :'),`                       대  표  자 : ${needed(ctx,c.representative,'대표자')}    (직인)`);
  if (data.applicationDate) {
    const [y,m,d]=data.applicationDate.split('-');
    setRootParagraph(ctx,s=>/^\s*년\s*월\s*일\s*$/.test(s),`${y}년 ${Number(m)}월 ${Number(d)}일`);
  } else ctx.warnings.push('신청일 미입력: 원본의 날짜 빈칸 유지');
  ctx.warnings.push('고객사 개인정보 동의·서명·직인은 자동 작성하지 않았습니다.');
}

// header/section의 스타일 ID, manifest, 모든 XML, 지정 셀 값을 검증합니다.
async function validatePackage(bytes, updates, expectedTables) {
  ensure(bytes.readUInt32LE(0)===0x04034b50, 'ZIP local header 없음');
  const nameLen=bytes.readUInt16LE(26), first=bytes.subarray(30,30+nameLen).toString('utf8');
  ensure(first==='mimetype' && bytes.readUInt16LE(8)===0,'mimetype은 첫 항목·무압축이어야 합니다.');
  const z=await JSZip.loadAsync(bytes,{checkCRC32:true});
  const xmlFiles=Object.keys(z.files).filter(n=>/\.(xml|hpf|rdf)$/i.test(n));
  for(const file of xmlFiles) parse(await z.file(file).async('string'));
  const doc=parse(await z.file('Contents/section0.xml').async('string'));
  const header=parse(await z.file('Contents/header.xml').async('string'));
  const tables=all(doc,'hp:tbl');
  ensure(tables.length===expectedTables,'출력 표 개수가 바뀌었습니다.');
  const chars=new Set(all(header,'hh:charPr').map(x=>x.attributes.id));
  const paras=new Set(all(header,'hh:paraPr').map(x=>x.attributes.id));
  const styles=new Set(all(header,'hh:style').map(x=>x.attributes.id));
  for(const n of walk(doc)) for(const [key,set] of [['charPrIDRef',chars],['paraPrIDRef',paras],['styleIDRef',styles]]) {
    if(n.attributes?.[key]!=null) ensure(set.has(n.attributes[key]),`없는 스타일 참조 ${key}=${n.attributes[key]}`);
  }
  const sections=Object.keys(z.files).filter(n=>/^Contents\/section\d+\.xml$/.test(n));
  ensure(Number(all(header,'hh:head')[0].attributes.secCnt)===sections.length,'구역 수 불일치');
  const hpf=parse(await z.file('Contents/content.hpf').async('string'));
  for(const item of all(hpf,'opf:item')) ensure(z.file(item.attributes.href),`누락 manifest 파일: ${item.attributes.href}`);
  for(const u of updates) {
    const cell=cellAt({tables},u.table,u.row,u.col);
    const result=children(children(cell,'hp:subList')[0],'hp:p').map(textOf).join('\n');
    ensure(result===u.text,`입력값 불일치 ${u.table}/${u.row}/${u.col}`);
  }
  ensure(await z.file('Preview/PrvText.txt').async('string')===documentText(doc),'미리보기 텍스트 불일치');
  return {zipCRC:'pass',xmlFilesParsed:xmlFiles.length,styleReferences:'pass',manifestReferences:'pass',
    sectionCount:sections.length,tableCount:tables.length,verifiedCells:updates.length,mimetypeFirstStored:true};
}

async function pack(ctx,title) {
  // 원본 줄 위치 캐시는 새 글자수와 맞지 않습니다. 한컴이 다시 배치하도록 제거합니다.
  for(const n of walk(ctx.doc)) if(n.elements) n.elements=n.elements.filter(e=>e.name!=='hp:linesegarray');
  const section=serialize(ctx.doc);
  const hpf=parse(await ctx.zip.file('Contents/content.hpf').async('string'));
  const titleNode=all(hpf,'opf:title')[0]; titleNode.elements=[textNode(title)];
  for(const n of all(hpf,'opf:meta')) {
    if(n.attributes.name==='lastsaveby') n.elements=[textNode('K-brand JavaScript generator')];
    if(n.attributes.name==='ModifiedDate') n.elements=[textNode(new Date().toISOString())];
  }
  const container=parse(await ctx.zip.file('META-INF/container.xml').async('string'));
  // 원본의 빈 양식 썸네일을 완성본처럼 보이지 않도록 제거합니다. 텍스트 preview는 갱신합니다.
  for(const n of walk(container)) if(n.elements) n.elements=n.elements.filter(e=>e.attributes?.['full-path']!=='Preview/PrvImage.png');
  const replacements={ 'Contents/section0.xml':section,'Contents/content.hpf':serialize(hpf),
    'Preview/PrvText.txt':documentText(ctx.doc),'META-INF/container.xml':serialize(container)};
  const out=new JSZip();
  out.file('mimetype','application/hwp+zip',{compression:'STORE',createFolders:false});
  for(const [name,item] of Object.entries(ctx.zip.files)) {
    if(item.dir || name==='mimetype' || name==='Preview/PrvImage.png') continue;
    out.file(name,replacements[name]??await item.async('nodebuffer'),{compression:'DEFLATE',createFolders:false});
  }
  const bytes=await out.generateAsync({type:'nodebuffer',compression:'DEFLATE',compressionOptions:{level:6},platform:'DOS'});
  const validation=await validatePackage(bytes,ctx.updates,ctx.tables.length);
  const z=await JSZip.loadAsync(bytes,{checkCRC32:true});
  for(const [name,item] of Object.entries(ctx.zip.files)) {
    if(item.dir || name==='Preview/PrvImage.png' || Object.hasOwn(replacements,name)) continue;
    ensure(Buffer.compare(await item.async('nodebuffer'),await z.file(name).async('nodebuffer'))===0,`비대상 파일이 변경됨: ${name}`);
  }
  validation.unchangedPackageEntries='pass';
  return {bytes,validation,text:documentText(ctx.doc),warnings:[...new Set(ctx.warnings)]};
}

async function generate({dataPath,outDir,templatesDir}) {
  const inputBytes=await fs.readFile(dataPath);
  const data=JSON.parse(inputBytes.toString('utf8').replace(/^\uFEFF/,''));
  validateInput(data);
  const company=stringValue(data.company.nameKo,'기업명',80).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_');
  await fs.mkdir(outDir,{recursive:true});
  const stamp=new Date().toISOString().replace(/[-:]/g,'').replace(/\..+$/,'').replace('T','_');
  const runDir=path.join(outDir,`${stamp}_${crypto.randomBytes(3).toString('hex')}`);
  // 양식과 데이터는 읽기만 하며, 매 실행 새 결과 폴더를 만듭니다.
  const products=[];
  for(const kind of ['application','plan']) {
    const ctx=await loadTemplate(path.join(templatesDir,`${kind}.hwpx`),kind);
    (kind==='application'?fillApplication:fillPlan)(ctx,data);
    const title=`${company}_${kind==='application'?'사용신청서':'활용계획서'}_검토용`;
    const result=await pack(ctx,title);
    products.push({kind,title,...result});
  }
  await fs.mkdir(runDir,{recursive:false});
  const report={generatedAt:new Date().toISOString(),source:data.source||null,inputSHA256:sha(inputBytes),
    templateSHA256:EXPECTED_HASH,engine:'Node.js + JSZip + xml-js (no AI API, no HWP automation)',
    scope:'한 상품 / 최대 3개 국가 / 텍스트 및 선택표시',
    visualValidation:'생성기 자체는 렌더링하지 않음. 한컴에서 열어 표·쪽 배치 확인 필요.',files:[]};
  for(const p of products) {
    const filename=`${p.title}.hwpx`;
    await fs.writeFile(path.join(runDir,filename),p.bytes,{flag:'wx'});
    await fs.writeFile(path.join(runDir,`${p.title}.txt`),p.text,{flag:'wx'});
    report.files.push({filename,bytes:p.bytes.length,sha256:sha(p.bytes),validation:p.validation,warnings:p.warnings});
  }
  await fs.writeFile(path.join(runDir,'validation.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  return {runDir,report};
}

if(require.main===module) {
  const args=process.argv.slice(2), opts={};
  for(let i=0;i<args.length;i+=2) {
    ensure(['--data','--out','--templates'].includes(args[i]) && args[i+1], '사용법: node generate-hwpx.js --data input.json --out result [--templates templates]');
    opts[args[i]]=args[i+1];
  }
  generate({dataPath:path.resolve(opts['--data']||path.join(__dirname,'input.json')),
    outDir:path.resolve(opts['--out']||path.join(__dirname,'result')),
    templatesDir:path.resolve(opts['--templates']||path.join(__dirname,'templates'))})
    .then(({runDir,report})=>console.log(JSON.stringify({resultFolder:runDir,files:report.files.map(f=>({name:f.filename,bytes:f.bytes,validation:f.validation}))},null,2)))
    .catch(err=>{console.error(`생성 실패: ${err.message}`);process.exitCode=1;});
}
module.exports={generate,validatePackage};
