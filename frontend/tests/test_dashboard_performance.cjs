const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const page = fs.readFileSync(path.join(__dirname, '../src/js/page/index.js'), 'utf8');
const chart = fs.readFileSync(path.join(__dirname, '../src/js/dashboard/chart.js'), 'utf8');

test('overlapping dashboard reads share work, while a new date range starts its own read', async () => {
  const requests = [];
  const context = vm.createContext({
    currentPeriod: '30', requestedRange: null, pendingLoad: undefined, pendingRange: undefined,
    fetchDashboard: () => new Promise(resolve => requests.push(resolve)),
  });
  vm.runInContext(page.slice(page.indexOf('function load()'), page.indexOf('async function fetchDashboard()')), context);
  const a = context.load();
  assert.equal(context.load(), a);
  assert.equal(requests.length, 1);
  context.currentPeriod = '7';
  const b = context.load();
  assert.notEqual(a, b);
  requests[0](); await a;
  assert.equal(context.load(), b); // completion of an old request cannot clear the new one
  requests[1](); await b;
  context.load();
  assert.equal(requests.length, 3);
  requests[2]();
});

test('closed chart tables defer DOM creation and opening exposes the complete current data', () => {
  const element = (tag, classes, text) => ({ tag, text, children: [], append(...nodes) { this.children.push(...nodes); } });
  const context = vm.createContext({ element, exact: String, scheduleDraw: () => {} });
  vm.runInContext('class Subject {' + chart.slice(chart.indexOf('  update(rows'), chart.indexOf('  reset()')) + '} globalThis.Subject = Subject;', context);
  const view = new context.Subject();
  Object.assign(view, { host: { dataset: {} }, range: {}, rows: [], series: [{ key: 'income', label: 'درآمد' }], details: { open: false },
    svg: { getAttribute: () => 'chart' }, tableHost: { children: [], replaceChildren() { this.children = []; }, append(n) { this.children.push(n); } }, draw() {} });
  view.update([{ label: 'روز اول', income: 10 }, { label: 'روز دوم', income: 20 }]);
  assert.equal(view.tableHost.children.length, 0);
  view.details.open = true; view.renderTable();
  assert.equal(view.tableHost.children[0].children[2].children.length, 2);
  view.update([{ label: 'روز جدید', income: 50 }]);
  assert.equal(view.range.hidden, true);
  assert.equal(view.tableHost.children[0].children[2].children.length, 1);
  assert.equal(view.tableHost.children[0].children[2].children[0].children[1].text, '50');
});

test('unrelated data changes preserve chart state and do not schedule a redraw', () => {
  let draws = 0;
  const context = vm.createContext({ scheduleDraw: () => draws++ });
  vm.runInContext('class Subject {' + chart.slice(chart.indexOf('  update(rows'), chart.indexOf('  renderTable()')) + '} globalThis.Subject = Subject;', context);
  const view = new context.Subject();
  Object.assign(view, {host:{dataset:{}},range:{},rows:[],series:[{key:'income'}],details:{open:false}});
  view.update([{label:'day',income:'100',tasks:1}]);
  view.pinned = true;
  view.update([{label:'day',income:'100',tasks:2}]);
  assert.equal(draws,1);
  assert.equal(view.pinned,true);
  view.update([{label:'day',income:'200',tasks:2}]);
  assert.equal(draws,2);
  assert.equal(view.pinned,true);
});

test('a chart frame measures all visible charts before drawing and skips offscreen work', () => {
  const frames = [], work = [];
  const context = vm.createContext({requestAnimationFrame: callback => {frames.push(callback);return frames.length;}});
  vm.runInContext(chart.slice(chart.indexOf('const pendingDraws'), chart.indexOf('export class Chart')), context);
  const subject = (name, visible) => ({ visible, dirty:true,
    measure(){work.push('measure '+name);return {width:200,height:100};},
    draw(){work.push('draw '+name);} });
  const a=subject('a',true),b=subject('b',true),c=subject('c',false);
  context.scheduleDraw(a);context.scheduleDraw(a);context.scheduleDraw(b);context.scheduleDraw(c);
  assert.equal(frames.length,1);frames[0]();
  assert.deepEqual(work,['measure a','measure b','draw a','draw b']);
});

test('summary widgets retain their DOM for unchanged values and retry a failed paint', () => {
  const context = vm.createContext();
  vm.runInContext(page.slice(page.indexOf('const renderedSections'), page.indexOf('function render(result')), context);
  const host = {}, paint = [];
  context.updateSection(host, ['100','income'], () => paint.push('initial'));
  context.updateSection(host, ['100','income'], () => paint.push('duplicate'));
  assert.deepEqual(paint,['initial']);
  assert.throws(() => context.updateSection(host, ['200','income'], () => {throw new Error('paint failed');}));
  context.updateSection(host, ['200','income'], () => paint.push('changed'));
  assert.deepEqual(paint,['initial','changed']);
});

test('an empty expense period clears previous category amounts from the legend', () => {
  const context = vm.createContext({scheduleDraw() {},element:(tag,classes,text)=>({text,style:{setProperty(){}}})});
  vm.runInContext('class Subject {' + chart.slice(chart.indexOf('  update(rows'),chart.indexOf('  renderTable()')) + '} globalThis.Subject=Subject;',context);
  const view=new context.Subject(), legend={children:[{text:'old expense',title:'123 تومان'}],classList:{remove(){}},replaceChildren(...nodes){this.children=nodes;}};
  Object.assign(view,{host:{dataset:{}},range:{},rows:[{label:'old expense',amount:'123'}],series:[{key:'amount',label:'هزینه',color:'blue'}],donut:true,legend,details:{open:false}});
  view.update([]);
  assert.equal(legend.children.length,1);
  assert.equal(legend.children[0].text,'هزینه');
  assert.equal(legend.children[0].title,undefined);
  assert.equal(view.range.hidden,true);
});

test('keyboard inspection initializes a deferred chart before using its geometry', () => {
  const context = vm.createContext({exact:String,element:(tag,classes,text)=>({text})});
  vm.runInContext('class Subject {' + chart.slice(chart.indexOf('  inspect(index'),chart.indexOf('  measure()')) + '} globalThis.Subject=Subject;',context);
  let draws=0;
  const view=new context.Subject();
  Object.assign(view,{rows:[{label:'Day',amount:'100'}],lo:0,hi:0,series:[{key:'amount',label:'amount'}],
    tip:{style:{},replaceChildren(){},append(){}},readout:{},highlight(){},
    draw(){draws++;this.width=100;this.dirty=false;this.x=()=>50;}});
  view.inspect(0,true);
  assert.equal(draws,1);
  assert.match(view.readout.textContent,/100/);
  view.inspect(0,true);
  assert.equal(draws,1);
});
