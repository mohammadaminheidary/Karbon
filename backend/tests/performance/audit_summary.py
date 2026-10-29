"""Summarize measured samples; never infer missing metrics or count failed loads."""
import json
import os
from pathlib import Path
import statistics
from collections import defaultdict

directory = Path(os.environ['KARBON_PERF_DIR']).resolve()


def read(name):
    return json.loads((directory/(name+'.json')).read_text())


def quantile(values, fraction):
    values = sorted(values)
    position = (len(values)-1)*fraction
    lo = int(position)
    return values[lo] + (values[min(lo+1,len(values)-1)]-values[lo])*(position-lo)


def stats(values):
    values = [v for v in values if isinstance(v,(int,float))]
    if not values:
        return None
    return dict(n=len(values),median=statistics.median(values),min=min(values),max=max(values),
        q25=quantile(values,.25),q75=quantile(values,.75),p95=quantile(values,.95),p99=quantile(values,.99))


def pair(before,after):
    a,b = stats(before),stats(after)
    return dict(before=a,after=b,reduction_percent=(a['median']-b['median'])/a['median']*100 if a and b and a['median'] else None,
        speedup=a['median']/b['median'] if a and b and b['median'] else None)


api_before,api_after = read('before-audit-api'),read('after-audit-api')
api = {name:{key:pair([row[key] for row in rows],[row[key] for row in api_after[name]])
    for key in ['ms','bytes','queries','sql_ms','cpu_ms']} for name,rows in api_before.items() if isinstance(rows,list) and rows and isinstance(rows[0],dict)}
api_gzip = {name:{key:pair([row[key] for row in rows],[row[key] for row in read('after-audit-api-gzip')[name]])
    for key in ['ms','bytes','wire_bytes','queries','sql_ms','cpu_ms']} for name,rows in read('before-audit-api-gzip').items() if isinstance(rows,list) and rows and isinstance(rows[0],dict)}
browser = {}
phases = {}
for phase in ['before','after']:
    phases[phase] = read(phase+'-pages')['results'] + read(phase+'-extras-pages')['results'] + read(phase+'-more-pages')['results']
    for row in phases[phase]:
        row['valid'] = not row.get('error') and not row.get('errors') and not row.get('failed')
        row['initial_queries'] = sum(x['count'] for x in row.get('initial_api',row.get('api',[])))
        row['all_queries'] = sum(x['count'] for x in row.get('api',[]))
        row['initial_api_count'] = len(row.get('initial_api',row.get('api',[])))
        row['initial_sql_ms'] = sum(x['sql_ms'] for x in row.get('initial_api',row.get('api',[])))
        row['all_sql_ms'] = sum(x['sql_ms'] for x in row.get('api',[]))
        if row['name']=='dashboard':
            request = next((r for r in row.get('resources',[]) if r['name']=='/api/dashboard'),None)
            if request:
                row['dashboard_request_start_ms']=request['start']
                row['dashboard_http_ms']=request['duration']
                row['after_api_ready_ms']=row['ready_ms']-request['end']
                row['after_api_visible_ms']=row['visible_ms']-request['end']
for name in dict.fromkeys(row['name'] for row in phases['before']):
    browser[name] = {}
    for mode in ['cold','warm']:
        a = [r for r in phases['before'] if r['name']==name and r['mode']==mode and r['valid']]
        b = [r for r in phases['after'] if r['name']==name and r['mode']==mode and r['valid']]
        keys = ['ready_ms','visible_ms','content_ms','all_widgets_ms','fcp_ms','initial_network','initial_bytes','network','network_bytes',
            'initial_queries','all_queries','initial_api_count','initial_sql_ms','all_sql_ms','TaskDuration_ms','ScriptDuration_ms','LayoutDuration_ms','RecalcStyleDuration_ms',
            'heap_mb','initial_dom_nodes','dom_nodes','longtask_ms','blocking_ms','all_task_ms','all_layout_ms','all_script_ms',
            'dashboard_request_start_ms','dashboard_http_ms','after_api_ready_ms','after_api_visible_ms','purchase_focus_ms']
        browser[name][mode] = {key:pair([r.get(key) for r in a],[r.get(key) for r in b]) for key in keys if any(key in r for r in a+b)}
        browser[name][mode]['counts'] = dict(before_success=len(a),after_success=len(b),trials=5)
writes = {name:{key:pair([r[key] for r in rows],[r[key] for r in read('after-audit-writes')[name]])
    for key in ['ms','queries','sql_ms','cpu_ms']} for name,rows in read('before-audit-writes').items()}
picker_rows = {phase: read(phase+'-picker') for phase in ['before','after']}
picker = {key:pair([r[key] for r in picker_rows['before'] if key in r and not r.get('error') and not r.get('failed')],
    [r[key] for r in picker_rows['after'] if key in r and not r.get('error') and not r.get('failed')])
    for key in ['ms','requests','bytes','options','task_ms']}
process = {}
for key in ['startup_ms','rss_start_mb','rss_dashboard_mb','idle_cpu_ms_over_300ms']:
    process[key] = pair([r[key] for r in read('before-process')['startup']],[r[key] for r in read('after-process')['startup']])
process['first_dashboard_ms'] = pair([r['first_dashboard']['ms'] for r in read('before-process')['startup']],
    [r['first_dashboard']['ms'] for r in read('after-process')['startup']])
process['preparation'] = {key:pair([r[key] for r in read('before-process')['preparation']],
    [r[key] for r in read('after-process')['preparation']]) for key in ['service_ms','cursor_ms','encoding_ms','json_ms']}
process['initial_preparation'] = {key:pair([r[key] for r in read('before-process').get('initial_preparation', read('before-process')['preparation'])],
    [r[key] for r in read('after-process').get('initial_preparation', read('after-process')['preparation'])]) for key in ['service_ms','cursor_ms','encoding_ms','json_ms']}
faces = {key:pair([r[key] for r in read('before-face-vectors')['rows']],[r[key] for r in read('after-face-vectors')['rows']])
    for key in ['read_validate_ms','cursor_ms','decrypt_ms','matching_ms']}
failures = {phase:[{k:r.get(k) for k in ['name','mode','iteration','error','errors','failed']} for r in rows if not r['valid']]
    for phase,rows in phases.items()}
profiles = {}
for phase in ['before','after']:
    totals = defaultdict(float)
    for event in read(phase+'-trace')['traceEvents']:
        if event.get('ph') == 'X' and event.get('dur'):
            totals[event['name']] += event['dur']/1000
    profile = read(phase+'-cpu-profile')
    nodes = {node['id']:node for node in profile['nodes']}
    samples = defaultdict(float)
    for identifier,delta in zip(profile['samples'],profile['timeDeltas']):
        frame = nodes[identifier]['callFrame']
        samples[frame['functionName']+' / '+frame['url'].split('/')[-1]] += delta/1000
    profiles[phase] = dict(single_traced_trial_ms=dict(totals),sampled_leaf_ms=dict(sorted(samples.items(),key=lambda item:-item[1])[:20]))
result = dict(environment=read('environment'),api=api,api_gzip=api_gzip,browser=browser,writes=writes,picker=picker,process=process,faces=faces,
    failures=failures,picker_failures={phase:[r for r in rows if r.get('error') or r.get('failed')] for phase,rows in picker_rows.items()},
    profiles=profiles,
    formula='reduction_percent = (before - after) / before * 100; speedup = before / after',
    caveats=['Browser medians exclude failed trials; failure counts are separate.', 'p99 from 40 API samples is an interpolation, not a reliable production tail.',
             'Cold HTTP cache does not mean cold OS cache.', 'All-widget timing includes a standardized automatic scroll through deferred widgets.'])
(directory/'audit-summary.json').write_text(json.dumps(result,indent=2,ensure_ascii=False))
print('Wrote audit-summary.json')
