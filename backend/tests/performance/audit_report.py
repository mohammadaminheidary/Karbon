"""Generate the Persian follow-up report from actual recorded samples."""
import csv
import json
import os
from pathlib import Path
import statistics

root = Path(__file__).resolve().parents[3]
data = Path(os.environ['KARBON_PERF_DIR']).resolve()
s = json.loads((data/'audit-summary.json').read_text())
lines = []


def add(text=''):
    lines.append(text)


def table(headers, rows):
    add('| ' + ' | '.join(headers) + ' |')
    add('|' + '|'.join(['---'] * len(headers)) + '|')
    for row in rows:
        add('| ' + ' | '.join(map(str, row)) + ' |')
    add()


def med(pair, phase):
    value = pair.get(phase)
    return value['median'] if value else None


def value(n, digits=2):
    return '—' if n is None else f'{n:.{digits}f}'


def comparison(pair, digits=2, divisor=1):
    a, b = med(pair, 'before'), med(pair, 'after')
    return f'{value(a/divisor if a is not None else None, digits)} → {value(b/divisor if b is not None else None, digits)}'


def gain(pair):
    return f"{value(pair['reduction_percent'], 1)}٪ / {value(pair['speedup'], 2)}×"


names = dict(dashboard='داشبورد', customers='مشتریان', orders='سفارش‌ها', finance='مالی', banks='حساب‌های بانکی',
    bank_ledger='دفتر یک بانک', inventory='انبار', tasks='کارها', settings='تنظیمات عمومی', documents='اسناد',
    attendance='حضور و غیاب', login='ورود', settings_products='تنظیمات محصولات', settings_invoices='فاکتورها',
    settings_members='اعضا', settings_banks='تنظیمات بانک‌ها', settings_inventory='تنظیمات انبار',
    settings_expenses='دسته‌های هزینه', settings_document_accounts='حساب‌های اسناد',
    settings_appearance='ظاهر', settings_security='امنیت', settings_backup='پشتیبان‌گیری', purchase='خرید')

add('# ممیزی تکمیلی عملکرد Karbon — ۲۹ اکتبر ۲۰۲۶')
add()
add('این گزارش فقط تغییرات این نوبت را نسبت به working tree موجود هنگام ورود می‌سنجد. بهینه‌سازی‌های قبلی مشتریان، دفتر مالی، بانک و کد مرجع از ابتدا در baseline حضور داشتند؛ سود آن‌ها دوباره به این نوبت نسبت داده نشده است. گزارش قدیمی در README همین پوشه مستقل نگه داشته شده است.')
add()
add('FastAPI و SQLite، قرارداد کامل APIها، قواعد مالی/موجودی، مجوزها و الگوریتم چهره حفظ شدند. تمام خواندن‌ها و نوشتن‌های آزمون در دیتابیس ساختگی موقت بوده‌اند. فایل واقعی کاربر باز یا تغییر داده نشد. SHA-256 دیتابیس پایه در پایان دوباره کنترل شد:')
add(f"`{s['environment']['base_sha256']}`")
add()
add('## روش اندازه‌گیری')
add()
add('- Apple M4، macOS 27.2 arm64، ۱۰ CPU منطقی، RAM برابر ۱۶ GiB؛ Chrome 156.0.8078.73، Python 3.13.15، Node 24.19.0، SQLite 3.50.4، FastAPI 0.141.1، SQLAlchemy 2.0.54، Pydantic 2.13.5، Uvicorn 0.53.0، Tailwind 4.3.3، OpenCV 4.13.0. منطقه زمانی Asia/Tehran.')
add('- داده ثابت: ۱۰۰۰ مشتری، ۱۰۰۰ سفارش، ۲۵۰ محصول، ۳۰۰۰ قلم سفارش، ۲۰۰۰ پرداخت مرتبط، مجموعاً ۵۴۰۰ تراکنش مالی، ۲۰ بانک، ۲۰۰۰ کار، ۳۰ عضو، ۹۰۰ حضور و ۲۰۰ سند. دیتابیس اصلی آزمون هیچ الگوی چهره‌ای ندارد؛ سنجش چهره در کپی مستقل با ۳۰ الگوی تصادفی رمزنگاری‌شده انجام شده است.')
add('- APIها: یک worker بدون reload، ۳ گرم‌سازی + ۴۰ درخواست ترتیبی برای هر مسیر و هر حالت identity/gzip. زمان HTTP شامل دریافت و decode JSON در کلاینت Python و در حالت gzip شامل بازکردن فشرده‌سازی است. CPU هدر زمان فرایند سرور است. SQL شامل احراز هویت و BEGIN؛ زمان cursor شامل fetch/ORM/پردازش Python نیست. لاگ‌برداری SQL در هر دو سمت فعال است.')
add('- مرورگر: headless Chrome، ۱۴۴۰×۱۱۰۰، بدون throttling، ۵ cold با context تازه و HTTP cache خاموش؛ warm شامل یک گرم‌سازی و ۵ نمونه با cache مشترک و تب تازه است. sessionStorage/API cache میان این تب‌ها مشترک نیست. cold به معنای پاک‌شدن OS page cache یا پردازش API نیست. startup در ۵ فرایند مستقل جدا سنجیده شد.')
add('- ready رویداد karbon:page-ready است؛ visible یعنی ready + آماده‌شدن فونت‌ها + دو animation frame. content اولین کارت عدددار + دو frame است. این‌ها معیار عملی مرز رسم هستند، نه TTI استاندارد یا زمان اندازه‌گیری‌شده GPU. تعامل واقعی جدا با E2E بررسی شد. all widgets شامل پیمایش خودکار یکسان تا انتهای داشبورد و انتظار برای جزئیات/نمودارهاست؛ زمان رندر خالص نمودار نیست.')
add('- قبل و بعد هر دو با CSS ساخته‌شده و سرور ثابت، بدون HMR/watch/reload اجرا شدند. pipeline اولیه بدون minify/hash/gzip بود؛ pipeline جدید production بخشی از تغییر اندازه‌گیری‌شده است. کنترل جدا با همان CSS بایت‌به‌بایت و همان سرور فایل اولیه انجام شده تا اثر کد از اثر pipeline قابل تفکیک باشد.')
add('- request count درخواست cache را هم می‌شمارد؛ bytes مرورگر از CDP شامل انتقال شبکه است، اندازه JSON API جداست. TaskDuration/ScriptDuration/LayoutDuration/RecalcStyleDuration از CDP، heap از JSHeapUsedSize؛ RSS فقط فرایند API است، نه کل Chrome/GPU و نه peak. trace و CPU profile در اجرای جدا بعد از نمونه‌های زمانی گرفته شدند.')
add('- heap نمونه لحظه‌ای بدون forced GC است؛ معادل حافظه retained یا اثبات نشت نیست. درصد مصرف کل CPU/GPU مرورگر و توان باتری سنجیده نشده است.')
add('- abort مرورگر فقط کار/پاسخ منسوخ کلاینت را کنار می‌گذارد؛ تضمین توقف SQL در حال اجرای سرور نیست. کاهش درخواست تکراری با هماهنگ‌کردن شروع درخواست‌ها انجام شده است.')
add('- میانه و IQR/min/max در JSON و CSV همراه‌اند. p95/p99 API با درون‌یابی خطی محاسبه شده؛ n=40 برای برآورد قابل اتکای دنباله تولید کم است. p99 مرورگر گزارش نمی‌شود. نمونه‌های بارگیری ناموفق از میانه زمان حذف، اما تعداد و جزئیاتشان مستقل گزارش شده است. زمان‌ها جمع‌پذیر نیستند؛ کار شبکه/اسکریپت/رسم همپوشانی دارد.')
add('- کاهش = (قبل − بعد) / قبل × ۱۰۰؛ ضریب سرعت = قبل / بعد. علامت منفی یعنی پسرفت. این اعداد سنجش throughput یا تضمین روی سخت‌افزار دیگر نیستند.')
add()
add('## داشبورد')
add()
add('در پروفایل مستقل اولیه، token/getComputedStyle و draw نمودار سهم بزرگی از نمونه‌های CPU داشتند؛ این نمونه‌ها شامل layout همزمان نیز می‌شوند و معادل زمان parsing خالص JavaScript نیستند. زمان trace تک‌اجرا با میانه‌های بدون profiler زیر متفاوت است؛ جمع categoryهای تو در تو همپوشانی دارد.')
add()
table(['trace مستقل، n=1؛ ms','قبل → بعد','کاهش مشاهده‌شده'],[
    [key, f"{s['profiles']['before']['single_traced_trial_ms'][key]:.2f} → {s['profiles']['after']['single_traced_trial_ms'][key]:.2f}",
     f"{(s['profiles']['before']['single_traced_trial_ms'][key]-s['profiles']['after']['single_traced_trial_ms'][key])/s['profiles']['before']['single_traced_trial_ms'][key]*100:.1f}٪"]
    for key in ['Layout','UpdateLayoutTree','Paint','v8.evaluateModule']])
add('به همین دلیل SVG با Canvas عوض نشد و کاهش دقت نقاط نمودار لازم نشد؛ اندازه‌گیری/رسم batch، defer نمودار خارج صفحه و preload فونت انتخاب شدند. فایل before-profile-trace نخستین پروفایل پیش از تغییر و before-trace تکرار نهایی baseline است.')
add()
dashboard_metrics = dict(ready_ms='رویداد آماده‌شدن، ms', content_ms='اولین کارت عدددار، ms', visible_ms='مرز رسم محتوای قابل مشاهده، ms',
    all_widgets_ms='تمام ویجت‌ها با پیمایش، ms', fcp_ms='FCP، ms', initial_bytes='انتقال اولیه، بایت', network_bytes='کل انتقال، بایت',
    initial_network='درخواست اولیه', network='کل درخواست', initial_queries='SQL اولیه', all_queries='SQL کل ویجت‌ها',
    initial_sql_ms='cursor اولیه، ms', all_sql_ms='cursor کل ویجت‌ها، ms', TaskDuration_ms='کار main thread اولیه، ms',
    ScriptDuration_ms='اسکریپت اولیه، ms', LayoutDuration_ms='layout اولیه، ms', RecalcStyleDuration_ms='style اولیه، ms',
    all_task_ms='کار main thread کل، ms', all_layout_ms='layout کل، ms', all_script_ms='اسکریپت کل، ms', heap_mb='JS heap اولیه، MiB',
    initial_dom_nodes='DOM اولیه', dom_nodes='DOM تمام ویجت‌ها', longtask_ms='زمان long task اولیه، ms', blocking_ms='مجموع مازاد ۵۰ms، ms',
    dashboard_request_start_ms='شروع درخواست داشبورد، ms', dashboard_http_ms='دریافت پاسخ داشبورد، ms', after_api_ready_ms='فاصله پایان پاسخ تا ready، ms',
    after_api_visible_ms='فاصله پایان پاسخ تا visible، ms')
for mode in ['cold','warm']:
    add(f'### {mode}')
    add()
    table(['معیار', 'قبل → بعد', 'کاهش / ضریب'], [(label,comparison(s['browser']['dashboard'][mode][key]),gain(s['browser']['dashboard'][mode][key]))
        for key,label in dashboard_metrics.items() if key in s['browser']['dashboard'][mode]])
control = json.loads((data/'controlled-data/after-pages.json').read_text())['results']
add('### کنترل با فایل‌های استاتیک اولیه')
add()
rows=[]
for mode in ['cold','warm']:
    valid=[r for r in control if r['mode']==mode and not r.get('error') and not r.get('errors') and not r.get('failed')]
    for key in ['ready_ms','visible_ms']:
        before=med(s['browser']['dashboard'][mode][key],'before');after=statistics.median(r[key] for r in valid)
        rows.append([mode+' / '+key,f'{before:.2f} → {after:.2f}',f'{(before-after)/before*100:.1f}٪ / {before/after:.2f}×',f'{len(valid)}/5'])
table(['معیار', 'قبل → کنترل کد جدید، ms', 'کاهش / ضریب', 'موفق'],rows)
add('در کنترل نیز یک قطع اتصال ماژول مشاهده شد؛ این کنترل عمداً از backlog/سرور استاتیک اولیه استفاده می‌کند. نتایج کنترل فقط نمونه‌های موفق را خلاصه می‌کنند.')
add()
add('## تمام صفحه‌های اندازه‌گیری‌شده')
add()
add('همه زمان‌ها ms؛ هر سلول visible، میانه قبل → بعد و سپس کاهش/ضریب را نشان می‌دهد. ready نشان‌دهنده رویداد آماده‌شدن است. انبار صفحه اصلی موجود و خرید فرم موجود برنامه‌اند؛ این آزمون وجود قابلیت ثبت خرید انبارداری جدیدی را ادعا نمی‌کند. بخش‌های امنیت/پشتیبان/ظاهر همان امکانات موجود را می‌سنجند.')
add()
table(['صفحه','cold ready','cold visible / کاهش، ضریب','warm ready','warm visible / کاهش، ضریب'],[
    [names[name],comparison(modes['cold']['ready_ms']),comparison(modes['cold']['visible_ms'])+' / '+gain(modes['cold']['visible_ms']),
     comparison(modes['warm']['ready_ms']),comparison(modes['warm']['visible_ms'])+' / '+gain(modes['warm']['visible_ms'])]
    for name,modes in s['browser'].items()])
for mode in ['cold','warm']:
    add(f'### منابع هر صفحه — {mode}')
    add()
    add('ستون‌های منابع، مقدار قبل → بعد را نشان می‌دهند. کاهش و ضریب هر معیار، همراه با پراکندگی، در audit-summary.json موجود است. این جدول منابع اولیه تا مرز visible است؛ منابع تمام ویجت‌های داشبورد بالاتر جدا آمده‌اند.')
    add()
    keys=['initial_network','initial_bytes','initial_queries','TaskDuration_ms','ScriptDuration_ms','LayoutDuration_ms','RecalcStyleDuration_ms','heap_mb']
    table(['صفحه','درخواست','انتقال KiB','SQL','main thread ms','اسکریپت ms','layout ms','style ms','heap MiB'],[
        [names[name],*[comparison(modes[mode][key],digits=2,divisor=1024 if key=='initial_bytes' else 1) for key in keys]] for name,modes in s['browser'].items()])
add('### شکست‌های بارگیری')
add()
for phase in ['before','after']:
    failures=s['failures'][phase]
    add(f'- {phase}: {len(failures)} شکست از ۲۳۰ نمونه ثبت‌شده. '+('; '.join(f"{r['name']}/{r['mode']}/#{r['iteration']}" for r in failures) if failures else 'هیچ شکست ثبت نشد.'))
add()
add('خطاهای اولیه عمدتاً ERR_CONNECTION_RESET/ERR_SOCKET_NOT_CONNECTED هنگام بارگیری ماژول بودند. نمونه‌های شکست و URL دقیق در JSON موجودند؛ warmupهای خارج از ۲۳۰ نمونه نیز در لاگ اجرای خام ممکن است خطا داشته باشند. در production صف پذیرش اتصال از ۵ به ۱۲۸ افزایش یافته، preload گراف ثابت اضافه شده و بخش‌های غیرضروری deferred هستند. نبود شکست در نمونه‌های بعد، تضمین حذف همه خطاهای شبکه نیست؛ نسبت‌دادن تمام قطع اتصال‌ها به backlog فقط یک استنباط است.')
add()
add('## API و نوشتن')
add()
table(['مسیر identity، n=40','p50 قبل → بعد','p95 قبل → بعد','p99 قبل → بعد','کاهش p50 / ضریب'],[
    [name,comparison(m['ms']),f"{m['ms']['before']['p95']:.2f} → {m['ms']['after']['p95']:.2f}",f"{m['ms']['before']['p99']:.2f} → {m['ms']['after']['p99']:.2f}",gain(m['ms'])] for name,m in s['api'].items()])
table(['مسیر identity','JSON بایت','SQL','cursor ms','CPU ms','کاهش CPU / ضریب'],[
    [name,comparison(m['bytes'],0),comparison(m['queries'],0),comparison(m['sql_ms'],3),comparison(m['cpu_ms'],3),gain(m['cpu_ms'])] for name,m in s['api'].items()])
add('dashboard_initial پیش از تغییر API کامل و پس از آن view=summary است؛ مقایسه تجربه اولیه با حفظ همه جمع‌های جهانی است. مسیر dashboard قرارداد کامل قدیمی را مقایسه می‌کند. در حالت summary دو فهرست جزئیات بدهکاران/فروش محصولات حذف می‌شوند و هنگام مشاهده به‌طور جدا بار می‌آیند.')
add()
table(['همان کلاینت Accept-Encoding: gzip','زمان ms','کاهش زمان / ضریب','بایت روی شبکه','کاهش بایت / ضریب','CPU ms'],[
    [name,comparison(m['ms']),gain(m['ms']),comparison(m['wire_bytes'],0),gain(m['wire_bytes']),comparison(m['cpu_ms'],3)] for name,m in s['api_gzip'].items()])
add('قبل gzip ارائه نمی‌شد؛ بعد JSON بزرگ‌تر از ۱۰۲۴ بایت با level=1 فشرده می‌شود. فایل‌های استاتیک از پیش فشرده هستند و CPU درخواست صرف ساخت gzip آن‌ها نمی‌شود. q=0 رعایت و پاسخ‌های کوچک از فشرده‌سازی عبور می‌کنند.')
add()
table(['نوشتن، n=40','p50 ms','کاهش / ضریب','p95 قبل → بعد','SQL','cursor ms','CPU ms'],[
    [name,comparison(m['ms']),gain(m['ms']),f"{m['ms']['before']['p95']:.2f} → {m['ms']['after']['p95']:.2f}",comparison(m['queries'],0),comparison(m['sql_ms'],3),comparison(m['cpu_ms'],3)] for name,m in s['writes'].items()])
add('برای هر نوع نوشتن ۴۳ درخواست با UUID تازه، ۳ گرم‌سازی + ۴۰ نمونه، پس از پایان تمام خواندن‌ها روی کپی جدا اجرا شد. الگوریتم نوشتن عوض نشده؛ تغییرات کوچک این جدول به‌تنهایی اثبات سود پایدار نیستند.')
add()
table(['بازکردن انتخاب مشتری در فرم مالی، ۵ نمونه','قبل → بعد','کاهش / ضریب'],[(key,comparison(pair),gain(pair)) for key,pair in s['picker'].items()])
add(f"شکست picker در مجموعه نهایی: قبل {len(s['picker_failures']['before'])}، بعد {len(s['picker_failures']['after'])}. اجرای اولیه این مرحله در baseline با timeout متوقف شد؛ با ثبت شکست برای تک‌تک نمونه‌ها، مرحله مستقل روی کپی تازه تکرار و همه نتایج نهایی ثبت شد. روش نهایی برای هر دو سمت یکسان است.")
add()
add('انتخاب‌گر اکنون ۱۰۰ گزینه اولیه دارد، جستجو و نمایش بیشتر و حفظ مشتری انتخاب‌شده خارج صفحه پشتیبانی می‌شود. زمان بازکردن شامل click خودکار Playwright است؛ فقط زمان پردازش داخلی نیست. bytes این سناریو شامل واکشی بانک‌ها نیز هست. پیمایش تمام ۱۰۰۰ مشتری و ترتیب/عدم تکرار جدا آزموده شده است.')
add()
add('## پردازش، حافظه و چهره')
add()
table(['۵ راه‌اندازی مستقل API','قبل → بعد','کاهش / ضریب'],[(key,comparison(pair),gain(pair)) for key,pair in s['process'].items() if key not in ['preparation','initial_preparation']])
for kind in ['preparation','initial_preparation']:
    add(f'{kind}: ۱۰ نمونه پس از ۳ گرم‌سازی؛ service شامل SQL، fetch/ORM و محاسبه است و cursor بخشی از آن است. encoding و serialization جدا سنجیده شده‌اند.')
    add()
    table(['بخش، ms','قبل → بعد','کاهش / ضریب'],[(key,comparison(pair,3),gain(pair)) for key,pair in s['process'][kind].items()])
diagnostic=json.loads((data/'full-diagnostic.json').read_text())
diag={phase:{key:statistics.median(statistics.median(row[key] for row in run['rows']) for run in diagnostic if run['phase']==phase)
    for key in ['service_ms','encoding_ms','json_ms']} for phase in ['before','after']}
add('پسرفت API کامل و preparation جدا بررسی شد: ۴ جفت فرایند قبل/بعد با ترتیب متناوب و ۴۰ نمونه پس از ۳ گرم‌سازی در هر فرایند. اعداد زیر میانه چهار میانه‌اند؛ جایگزین جدول اصلی نشده‌اند. اختلاف بزرگ preparation در این تکرار بازتولید نشد، پس نسبت‌دادن تمام اختلاف اولیه به کد یا gzip موجه نیست؛ پسرفت اندازه‌گیری HTTP اصلی همچنان گزارش شده است.')
add()
table(['تشخیص تکمیلی API کامل، ms','قبل → بعد','کاهش'],[[key,f"{diag['before'][key]:.3f} → {diag['after'][key]:.3f}",f"{(diag['before'][key]-diag['after'][key])/diag['before'][key]*100:.2f}٪"] for key in diag['before']])
table(['۳۰ الگوی رمزنگاری‌شده، n=40؛ ms','قبل → بعد','کاهش / ضریب'],[(key,comparison(pair,3),gain(pair)) for key,pair in s['faces'].items()])
face_before=json.loads((data/'before-face-vectors.json').read_text());face_after=json.loads((data/'after-face-vectors.json').read_text())
table(['مدل/guard، یک اجرا در هر مرحله','قبل','بعد'],[
    ['بارگیری مدل ms',value(face_before['model_ms']),value(face_after['model_ms'])],
    ['RSS پیش از مدل MiB',value(face_before['rss_before_mb']),value(face_after['rss_before_mb'])],
    ['RSS پس از مدل MiB',value(face_before['rss_after_mb']),value(face_after['rss_after_mb'])],
    ['BUSY 429، میانه ۱۰ تلاش ms',value(statistics.median(face_before['busy_ms']),3),value(statistics.median(face_after['busy_ms']),3)]])
http_faces={phase:json.loads((data/f'{phase}-face.json').read_text()) for phase in ['before','after']}
table(['HTTP چهره؛ ms','قبل → بعد','کاهش مشاهده‌شده'],[
    [label,f'{a:.3f} → {b:.3f}',f'{(a-b)/a*100:.2f}٪']
    for label,a,b in [
        ('اولین status با model load؛ n=1',http_faces['before'][0]['ms'],http_faces['after'][0]['ms']),
        ('status گرم؛ n=4',statistics.median(r['ms'] for r in http_faces['before'][1:5]),statistics.median(r['ms'] for r in http_faces['after'][1:5])),
        ('راهنمای JPEG خالی/NO_FACE؛ n=10',statistics.median(r['ms'] for r in http_faces['before'][5:]),statistics.median(r['ms'] for r in http_faces['after'][5:]))]])
add('برای چهره تغییری در کد سرویس، مدل، رمزنگاری، آستانه/حاشیه تطبیق یا lock داده نشد. اعداد پیش/پس در این بخش مشاهده‌اند و سود منتسب به اصلاح الگوریتم نیستند. matching روی بردارهای تصادفی قابل بازتولید، status و JPEG خالی و سناریوی دوربین مصنوعی سنجیده شدند؛ دقت تشخیص واقعی با این داده‌ها قابل سنجش نیست. آزمون اختیاری تصویر واقعی به‌علت نبود ورودی اجرا نشد. idle CPU در پنجره ۳۰۰ms و یک model load در هر مرحله برای نتیجه آماری درباره مصرف پایدار کافی نیستند.')
add()
add('## تغییرات و صحت')
add()
add('- dashboard/chart.js و theme.js: اندازه‌گیری هندسه همه نمودارهای قابل مشاهده قبل از نوشتن SVG در یک RAF مشترک؛ IntersectionObserver، dedup اندازه ResizeObserver، حفظ zoom/selection، صرف‌نظر از رسم داده بدون تغییر، CSS variables برای رنگ‌ها، رفع legend تهی و ورودی keyboard پیش از رسم deferred.')
add('- page/index.js و layout-editor.js/layout-tools.js: summary اولیه، جزئیات هنگام مشاهده، تطبیق revision/بازه و abort پاسخ قدیمی، ادغام جزئیات قابل مشاهده با refresh اصلی در یک snapshot، cache تغییرات هر بخش برای حفظ DOM، بارگیری ابزار چیدمان فقط با Edit، بازیابی controller پس از BFCache. رویدادهای focus همزمان ادغام می‌شوند؛ پاسخ مالی سرور cache نشده است.')
add('- dashboard_service.py و routes/dashboard.py: استفاده مجدد از aggregation بدهی/سررسید موجود برای نماهای lazy، summary بدون جزئیات ثانویه، full سازگار و totals جهانی دقیق؛ محاسبات پول صحیح و snapshot خواندن حفظ شدند. aggregation بدهی از ابتدا در baseline بهینه بود؛ این نوبت سود آن دوباره محاسبه نشده است. API جزئیات lazy داده روز را می‌خواند و هنگام refreshِ جزئیات مرئی، همه در همان snapshot خلاصه برمی‌گردند.')
add('- order_service.py: batch مشترک مشتری/اقلام/پرداخت برای سفارش‌ها و فاکتورها، تجمیع شمارش وضعیت. بهینه‌سازی‌های قبلی مشتری، دفتر بانک، مالی و کد مرجع با تست‌های correctness و query budget بررسی شدند. EXPLAIN دفتر بانک از ix_finance_bank_live_date استفاده می‌کند؛ index جدید حدسی اضافه نشد.')
add('- customer_service.py، routes/customers.py، customer-api.js و customer-select.js، فرم/ویرایش تراکنش: endpoint سبک با lookup دقیق مشتری انتخاب‌شده، جستجوی debounce، صفحه‌بندی، abort/guard و retry؛ select بومی و اعتبارسنجی/دسترسی‌پذیری حفظ شدند. تنظیمات lazy import و Intl formatterهای مشترک از راه‌اندازی غیرضروری و ساخت مکرر formatter جلوگیری می‌کنند.')
add('- build_production.py، serve_frontend.py، package.json و start.py: hash محتوایی وابستگی‌ها و importها/CSS import، modulepreload ثابت، preload فونت، gzip فایل‌ها، immutable یک‌ساله فقط برای نام‌های نسخه‌دار و revalidate برای HTML، حفظ chunk قدیمی برای تب باز، سرو فقط فایل عمومی dist و رد traversal/private/gzip مستقیم؛ اجرای production بدون reloader. فشرده‌سازی API سطح۱ با مذاکره encoding اضافه شد. وابستگی runtime جدیدی نصب نشد.')
add('- سازگاری کامل JSONهای API روی دیتابیس پایه و totals summary کنترل شد؛ generated_at تنها مقدار نادیده‌گرفته‌شده است. در آزمون‌های نوشتن، تراکنش/rollback، موجودی، پرداخت‌ها، تاریخچه، حذف/ارجاع، مجوز و مبالغ بزرگ هم پوشش دارند. گستره invalidation مشترک موجود در موارد مالی مرتبط حفظ شده تا stale data تولید نشود؛ cache مالی جدیدی ایجاد نشد.')
add()
add('آزمون‌های واقعاً اجراشده: backend unittest: ۱۱۳ اجرا، ۱۱۲ موفق و ۱ اختیاری تصویر واقعی skipped؛ frontend Python: ۱۲ موفق؛ Node: ۷۲ موفق. browser dashboard، data_fetching،refresh،startup،navigation،face_attendance،warehouse،purchase_transition و performance_features همگی موفق شدند. گزارش‌های فشرده همراه داده ذخیره‌اند. آخرین تست production شامل BFCache واقعی، بارگیری همه مشتریان، شکست/بازیابی جزئیات، چیدمان ذخیره‌شده، رنگ‌ها و عرض‌های ۳۹۰/۷۶۸/۱۴۴۰ است.')
add()
add('شکست‌های حین کار پنهان نشده‌اند: bind اولیه زیر sandbox با PermissionError روبه‌رو شد و فقط سرورهای ساختگی با مجوز محیط اجرا شدند؛ race اعلان busy تنظیمات پس از lazy import اصلاح شد؛ CSS @import ابتدا 404 داشت، اصلاح و تست اختصاصی اضافه شد و اندازه‌گیری نسخه خراب کنار گذاشته شد؛ selector آزمون navigation میان دو لینک مشابه مبهم بود و به navbar محدود شد. این‌ها نتیجه نهایی ناموفق باقی نگذاشته‌اند. شکست‌های شبکه baseline جدا بالا ثبت‌اند.')
add()
add('## هزینه‌های باقی‌مانده و حدود نتیجه')
add()
add('بارگیری همه ویجت‌های lazy نسبت به واکشی یک پاسخ کامل، رفت‌وبرگشت/SQL اضافه دارد؛ هزینه کل و تغییر script/DOM/heap بالاتر دقیقاً در جدول داشبورد گزارش شده است. summary سریع‌تر به معنی سریع‌ترشدن تمام API کامل یا نوشتن‌ها نیست؛ همه پسرفت‌های منفی در جداول حفظ شده‌اند. با تغییر داده مرتبط، totals و جزئیات مرئی دوباره در یک درخواست snapshot می‌شوند.')
add()
add('پسرفت‌های قابل توجه دیگر: marker سرد انبار ۲۴٫۶ → ۲۶٫۸ms شده، هرچند visible آن سریع‌تر است؛ heap لحظه‌ای warm حضور ۱٫۷۱ → ۲٫۴۰MiB و محصولات تنظیمات حدود ۲٫۰۷ → ۲٫۴۷MiB است. چند هزینه اسکریپت تنظیمات نیز حدود ۸–۱۳٪ بالاتر است. این مقادیر حذف نشده‌اند؛ کاهش main thread یا انتقال به معنی بهبود تک‌تک معیارها نیست. نگه‌داشتن chunkهای قدیمی برای تب‌های باز هزینه دیسک دارد؛ پاکسازی نسخه‌های قدیمی پس از پایان عمر تب‌ها یک کار نگهداری باقی‌مانده است.')
add()
add('صفحه کارها هنوز ۲۰۰۰ کار و نمودار موجودی هنوز ۲۵۰ محصول را می‌خواند؛ virtualization/صفحه‌بندی با حفظ جستجو، keyboard و totals قدم بعدی قابل سنجش است. برای گزارش‌های فعلی precompute/materialized summary و برای الگوهای چهره cache جدید توجیه نشده‌اند. ظرفیت تحت بار همزمان، CPU/GPU کل مرورگر، اندازه‌گیری خالص هر SVG، دقت تشخیص واقعی، شبکه موبایل و زمان استاندارد TTI اندازه‌گیری نشده‌اند. proxy هم‌مبدأ بنچمارک preflight واقعی CORS را حذف می‌کند؛ CORS در تست launcher جدا بررسی شده است.')
add()
add('## بازتولید و فایل‌های شاهد')
add()
add('مرجع baseline: commit 416065af2351344243bcaacf72963017ead40110 + entry-baseline.patch. فایل CSS اولیه و run.py/server.py اصلی نیز همراه‌اند؛ مدل‌ها همان فایل‌های موجود repo هستند. برای بازسازی baseline یک checkout جدا بسازید، patch را آنجا اعمال و CSS/هارنس اصلی را در مسیرهای متناظر قرار دهید. هیچ‌گاه این دستورات را روی دیتابیس واقعی اجرا نکنید.')
add()
add('```sh\nexport KARBON_PERF_DIR="$(mktemp -d /private/tmp/karbon-perf.XXXXXX)"\npython3 -c \'import gzip,os,pathlib; pathlib.Path(os.environ["KARBON_PERF_DIR"],"base.db").write_bytes(gzip.decompress(pathlib.Path("docs/performance/followup-data/synthetic-base.db.gz").read_bytes()))\'\n# Set KARBON_PLAYWRIGHT_PATH and KARBON_CHROME_PATH to the installed tools.\npython3 -B backend/tests/performance/audit_run.py before --root /absolute/path/to/baseline\nKARBON_API_BASE_URL=http://127.0.0.1:5529/api npm --prefix frontend run build\npython3 -B backend/tests/performance/audit_run.py after --production\npython3 -B backend/tests/performance/audit_full_diagnostic.py /absolute/path/to/baseline\n# Recreate controlled-source/data as described above for the original-assets control:\nKARBON_PERF_DIR="$KARBON_PERF_DIR/controlled-data" python3 -B backend/tests/performance/audit_run.py after --root /absolute/path/to/controlled-source --mode control\npython3 -B backend/tests/performance/audit_verify.py\npython3 -B backend/tests/performance/audit_summary.py\npython3 -B backend/tests/performance/audit_report.py\npython3 -B backend/tests/performance/audit_export.py\n# Restore the normal production origin after benchmarking:\nnpm --prefix frontend run build\n# Normal application launch (uses the user-configured database):\npython3 start.py --production\n```')
add()
add('دستورهای آزمون واحد (هر بار با مسیر bootstrap ساختگی؛ خود تست‌ها نیز fixture جدا می‌سازند):')
add()
add('```sh\nKARBON_DATABASE_PATH="$KARBON_PERF_DIR/test-bootstrap.db" KARBON_JWT_SECRET=isolated-tests python3 -B -m unittest discover -s backend/tests -v\nKARBON_DATABASE_PATH="$KARBON_PERF_DIR/test-bootstrap.db" KARBON_JWT_SECRET=isolated-tests python3 -B -m unittest discover -s frontend/tests -v\nnpm --prefix frontend test\n# Example browser fixture; run each suite with a fresh fixture and its header prerequisites:\npython3 -B frontend/tests/serve_customers_fixture.py --backend-port 8030 --frontend-port 5530 --customers 25 --bank-ledger 25 --orders --members 3\nKARBON_TEST_URL=http://127.0.0.1:5530 node frontend/tests/dashboard_browser.mjs\n# Production large-data assertions use performance/run.py after and audit_api.py after --writes first:\nnode frontend/tests/performance_features_browser.mjs\n```')
add()
add('برای تکرار دقیق داده تاریخ‌دار، تاریخ/منطقه زمانی آزمون باید همان ۲۹ اکتبر ۲۰۲۶ باشد؛ در روز دیگر seed تازه و baseline/after تازه در همان روز بسازید. seed.py و نام/نسخه وابستگی‌های ابزار در repo موجودند. اجرای کنترل به controlled-data/base.db و کپی source فعلی با CSS/هارنس اولیه نیاز دارد. پورت‌های ۸۰۲۹/۵۵۲۹ باید آزاد باشند؛ runner به فرایند متعلق به کاربر دست نمی‌زند و فقط فرایند خود را با SIGINT متوقف می‌کند.')
add()
add('داده‌های [خلاصه JSON](followup-data/audit-summary.json)، [محیط](followup-data/environment.json)، [manifest](followup-data/manifest.json)، CSV زمان صفحات، نمونه‌های خام API/pages، trace و CPU profile، لاگ آزمون‌ها، patch پایه و دیتابیس کاملاً ساختگی در followup-data هستند. token و کلید رمزنگاری صادر نشده‌اند. report و export با allowlist صریح تولید می‌شوند.')
destination=root/'docs/performance/2026-10-29-followup.md'
destination.write_text('\n'.join(lines)+'\n')
csv_path=root/'docs/performance/followup-data/page-timings.csv'
csv_path.parent.mkdir(parents=True, exist_ok=True)
with csv_path.open('w',newline='') as f:
    writer=csv.writer(f)
    writer.writerow(['page','mode','phase','n','ready_median_ms','visible_median_ms','visible_min_ms','visible_q25_ms','visible_q75_ms','visible_max_ms'])
    for name,modes in s['browser'].items():
        for mode,metrics in modes.items():
            for phase in ['before','after']:
                v=metrics['visible_ms'][phase]
                writer.writerow([name,mode,phase,v['n'],med(metrics['ready_ms'],phase),*[v[k] for k in ['median','min','q25','q75','max']]])
print(f'Wrote {destination}')
