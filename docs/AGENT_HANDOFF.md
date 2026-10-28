> مسیرهای فایل در این سند با ساختار backend/frontend به‌روز شده‌اند. آمار و وضعیت Git زیر، گزارش تاریخی پیش از بازآرایی هستند. راهنمای فعلی: [ساختار پروژه](project-layout.md).

# یادداشت تحویل پروژه Karbon برای ایجنت بعدی

**آخرین برداشت:** ۲۴ اکتبر ۲۰۲۶\
**شاخه:** `develop`، مبنای مشاهده‌شده `364e36b` (`feat: unify navbar panels and notifications`)\
**وضعیت مهم:** workspace هنگام تهیه این یادداشت از قبل تغییرات ذخیره‌نشده داشت. هیچ‌یک از آن تغییرات را دست نزدم؛ این فایل تازه برای تحویل اضافه شده است. گزارش وضعیت پایین، snapshot قبل از افزودن همین فایل است.

## پروژه در یک نگاه

Karbon یک برنامه مدیریت کسب‌وکار فارسی و راست‌به‌چپ است: داشبورد، مشتریان، سفارش و فاکتور، دفتر مالی و بانک، اسناد، اعضا و حضور‌وغیاب، کارهای روزانه، تنظیمات و قابلیت انبار در حال توسعه. رابط کاربری HTML/CSS/JavaScript ماژولار است؛ API با FastAPI و SQLAlchemy نوشته شده و داده‌ها در SQLite نگهداری می‌شوند. تاریخ و ساعت پیش‌فرض برنامه بر مبنای `Asia/Tehran` است و بسیاری از ورودی‌ها و نمایش‌ها شمسی‌اند.

## فناوری‌ها، اجرا و داده

- **Backend:** Python، FastAPI، Pydantic، SQLAlchemy، SQLite، JWT و bcrypt. قابلیت تاریخ شمسی از `jdatetime` استفاده می‌کند. حضور‌وغیاب چهره از OpenCV، NumPy، Pillow و مدل‌های ONNX موجود در `backend/face_models/` استفاده می‌کند.
- **Frontend:** HTML صفحات جداگانه، JavaScript ES modules، Tailwind CSS v4.3.3، CSS اختصاصی هر دامنه و فونت/ظاهر فارسی پروژه. وابستگی Node فعلی عمدتاً Tailwind CLI و ابزارهای توسعه است.
- **اجرای معمول:** `python3 -m pip install -r backend/requirements.txt` و `npm --prefix frontend install`؛ سپس `python3 start.py`. اسکریپت استایل را می‌سازد، سرور API را روی `127.0.0.1:8000` و فرانت‌اند را روی `127.0.0.1:5501` بالا می‌آورد و صفحه ورود را باز می‌کند. API مستندشده معمولاً زیر `/api` است.
- **اجرای توسعه استایل:** `npm --prefix frontend run dev`؛ ابتدا ناوبری مشترک را render می‌کند و سپس Tailwind را در حالت watch اجرا می‌کند.
- **دیتابیس:** پیش‌فرض `~/.karbon/karbon.db`؛ `KARBON_DATABASE_PATH` مسیر جایگزین و `KARBON_TIMEZONE` منطقه زمانی را تعیین می‌کند. تنظیمات در `backend/config.py` است. Foreign keyهای SQLite روشن‌اند. فایل `.env` و کلیدها محرمانه‌اند و نباید در گزارش، commit یا پاسخ‌ها کپی شوند.
- **راه‌اندازی DB:** `backend/app.py` مدل‌ها را import می‌کند، `Base.metadata.create_all` را اجرا و برخی ارتقاهای افزایشی سرویس‌ها را فراخوانی می‌کند. دیتابیس واقعی را برای آزمایش/بازنشانی دستکاری نکنید؛ تست‌های پروژه fixture دیتابیس موقت دارند.
- **ناوبری:** مرجع مشترک `frontend/src/templates/navbar.html` است؛ `frontend/scripts/build_navigation.py` آن را داخل صفحات علامت‌گذاری‌شده render می‌کند. `--check` فقط تطابق را بررسی می‌کند.

## قابلیت‌ها و قواعد دامنه‌ای که باید حفظ شوند

- **مشتریان:** CRUD و جستجو/صفحه‌بندی محافظت‌شده، شماره‌ها و کد مشتری نرمال‌شده، هشدار و تأیید ثبت تکراری، آمار سفارش/پرداخت و حذف محافظت‌شده در حضور سوابق مالی. کدهای نمایشی بعد از حذف پیوسته می‌شوند و شناسه داخلی ثابت است. قرارداد و تاریخچه: `docs/customers.md`.
- **سفارش و فاکتور:** کالاها در تنظیمات تعریف می‌شوند؛ فاکتور snapshot تاریخی اقلام/مشتری دارد. ثبت نهایی، پرداخت‌ها و تغییر موجودی کالا در تراکنش اتمیک SQLite است؛ پرداخت‌ها به دفتر مالی مشترک وصل‌اند. UUID برای تکرار امن درخواست، قفل نوشتن برای رقابت، ویرایش کالا با `revision`، جزئیات/خروجی فاکتور، تکمیل مستقل از تسویه، جستجوی فاکتورها و حذف نرم/بازگردانی موجودی پیاده‌سازی شده‌اند. پرداخت فاکتور را از فرم عمومی تراکنش مالی ویرایش/حذف نکنید. `docs/orders.md`.
- **دفتر مالی و بانک:** منبع حقیقت دریافت/هزینه، جدول تراکنش‌های مالی است. مبالغ عدد صحیح تومان‌اند؛ تاریخ داخلی میلادی و نمایش/ورودی شمسی است. مانده بانک از مانده اولیه + درآمد − هزینه محاسبه می‌شود. دفتر روزانه و دفتر هر حساب، فیلتر/جستجو/صفحه‌بندی، نمودار، دسته هزینه و مدیریت حساب، ویرایش/حذف محافظت‌شده با رمز و حذف نرم دارند. `docs/finance.md`, `docs/banks.md`, `docs/bank-ledger.md`.
- **داشبورد:** گزارش احراز هویت‌شده از داده‌های جاری، بدون نمونه‌سازی؛ API بازه تاریخ و جمع‌های دقیق را ارائه می‌دهد. درآمد/هزینه از دفتر مالی است؛ فروش از سفارش‌ها و دریافتی‌ها جداست. ارزش موجودی فعلی بر اساس قیمت فروش است، نه بهای تمام‌شده یا تاریخچه گردش (چنین تاریخچه‌ای در مدل فعلی نیست). ۱۸ ویجت، layout مستقل breakpoint/account و refresh دارند. `docs/dashboard.md`.
- **حضور‌وغیاب:** حضور دستی و ثبت/تطبیق چهره سه‌زاویه‌ای با رضایت، رمزنگاری templateهای چهره و محدودیت درخواست. تصاویر خام نباید در پاسخ خطا، API، cache یا فایل عمومی ظاهر شوند. قابلیت تشخیص چهره liveness نیست؛ مراجعه به `docs/face-attendance.md` پیش از هر تغییری در این قسمت الزامی است.
- **مستندات دیگر:** `docs/` شامل هفت راهنمای دامنه‌ای است: مشتری، داشبورد، مالی، بانک، دفتر حساب بانک، سفارش و حضور‌وغیاب چهره. این فایل‌ها حاوی قراردادهای دقیق API و گزارش بررسی‌های قبلی‌اند؛ README فقط معرفی کوتاه محصول است.

## انبار: وضعیت فعلی workspace (تغییرات ذخیره‌نشده)

تغییرات موجود، یک صفحه «انبار» را به ناوبری اضافه کرده‌اند، تنظیم دسته‌بندی و واحد را در تنظیمات آورده‌اند و فرم/پنل آغازین «خرید کالا» را می‌سازند. مدل تازه `InventoryOption` با جدول `inventory_options`، قید یکتایی `(kind, name)` و kindهای `categories` و `units` به مدل‌ها اضافه شده؛ endpointهای تنظیمات زیر احراز هویت‌اند:

- `GET /api/settings/inventory-options`
- `POST /api/settings/inventory-options/{kind}`
- `PUT /api/settings/inventory-options/{kind}/{option_id}`

**محدودیت مهم:** کد فرم خرید (`frontend/src/js/warehouse/purchase-entry.js`) فعلاً در submit فقط `preventDefault()` دارد. شماره و تاریخ موقت/نمایشی تولید می‌شوند و دسته/واحد فعال از API تنظیمات بارگیری می‌شوند، اما endpoint یا مدل خرید، ثبت خرید، محصول/کالای انبار، گردش موجودی، رسید انبار، پرداخت خرید، و اتصال به دفتر مالی در این تغییرات دیده نمی‌شود. در تحلیل و ادامه کار، UI اولیه را با عملیات ذخیره‌شده اشتباه نگیرید. مستند `docs/dashboard.md` هم می‌گوید فعلاً تاریخچه حرکت کالا/ارزش موجودی گذشته وجود ندارد.

## نقشه فایل‌ها

- `backend/app.py`: ساخت FastAPI، middleware، CORS، DB و ثبت routerها.
- `backend/routes/`, `schemas/`, `services/`, `models/`, `security/`: مرزبندی endpoint، قرارداد ورودی/خروجی، منطق دامنه، ORM و احراز هویت/امنیت.
- `start.py`, `frontend/serve_frontend.py`, `backend/run.py`: اجرای محلی برنامه.
- `frontend/index.html`, `frontend/page/*-page.html`: پوسته و صفحات مستقل.
- `frontend/src/js/page/`: نقطه شروع هر صفحه؛ `frontend/src/js/components/`: اجزای مشترک، ناوبری، dialog، cache و رویدادهای refresh؛ سایر پوشه‌های `frontend/src/js/` دامنه‌ای‌اند.
- `frontend/src/input.css`, `frontend/src/output.css`, `frontend/src/*.css`: Tailwind ورودی/خروجی و استایل‌های دامنه. `frontend/src/output.css` و `frontend/node_modules/` طبق `.gitignore` تولیدی/محلی‌اند.
- `backend/data/banks.json`, `frontend/assets/`: داده مرجع و منابع بصری.
- `backend/tests/` و `frontend/tests/`: تست‌های API، Python، Node و مرورگر؛ fixture مرورگر دیتابیس موقت می‌سازد.

## آمار snapshot پروژه

شمارش از فایل‌های قابل‌مشاهده در snapshot انجام شد؛ فایل‌های Git، `node_modules`، `output` و `__pycache__` را در شمارش کل کنار گذاشتیم. تعداد تست‌ها تعداد **فایل** است، نه تعداد case.

| مورد | تعداد |
| --- | ---: |
| فایل HTML ریشه و صفحات | ۱۲ (۱ ریشه + ۱۱ زیر `frontend/page/`) |
| فایل Python در backend | ۵۹ |
| فایل JavaScript در `frontend/src/js` | ۶۸ |
| فایل CSS در `frontend/src/` | ۱۳ |
| فایل راهنمای Markdown در `docs/` | ۷ |
| تست Python `test_*.py` | ۱۹ |
| تست Node `test_*.cjs` | ۱۳ |
| تست مرورگر `*_browser.mjs` | ۸ |
| decoratorهای route در `backend/routes/` | ۶۹ |
| فایل‌های tracked در Git، در لحظه بررسی | ۲۳۷ |

## وضعیت Git در زمان بررسی

شاخه `develop` نسبت به `origin/develop` clean نبود؛ ۱۵ مسیر modified و ۱۳ مسیر untracked در خروجی `git status --short` دیده شد. هیچ تغییری از آن‌ها را overwrite، stage، commit یا stash نکنید مگر صریحاً از ایجنت خواسته شود.

**Modified:** `backend/app.py`, `backend/models/__init__.py`, `frontend/index.html`, صفحات attendance/bank-transactions/banks/customers/daily-tasks/documents/finance/orders/settings، `frontend/scripts/build_navigation.py`, `frontend/src/js/page/settings.js`, `frontend/src/templates/navbar.html`.

**Untracked:** `backend/models/inventory.py`, `backend/routes/inventory.py`, `backend/schemas/inventory_schema.py`, `backend/services/inventory_service.py`, `frontend/page/warehouse-page.html`, `frontend/src/inventory-settings.css`, `frontend/src/js/page/warehouse.js`, `frontend/src/js/warehouse/`، `frontend/src/warehouse.css`, `frontend/tests/purchase_transition_browser.mjs`, `backend/tests/test_inventory_settings.py`, `frontend/tests/warehouse_browser.mjs`.

تغییرهای tracked عمدتاً اتصال router و مدل inventory، افزودن بخش تنظیمات inventory و لینک صفحه warehouse به navbar صفحات‌اند؛ فایل‌های untracked بدنه فعلی تنظیمات دسته/واحد و فرم آغازین خرید هستند. پیش از کار تازه، `git status --short` را دوباره بخوانید؛ وضعیت ممکن است در این فاصله تغییر کرده باشد.

## تست و سطح اطمینان

موجودی تست‌ها در جدول بالا شمارش فایل است. مستندات دامنه گزارش می‌کنند که بسیاری از تست‌های بک‌اند، Node و بررسی‌های دستی/مرورگر برای قابلیت‌های قبلی اجرا و موفق شده‌اند؛ تعدادهای آن گزارش‌ها متعلق به زمان تهیه همان مستندات است، نه اجرای فعلی. این handoff هنگام تهیه **هیچ تستی اجرا نکرده** و صحت فعلی workspace را تأیید نمی‌کند. برای ادامه کار، تست مرتبط با تغییر را اجرا کنید؛ برای suite کلی، دستور مستند `python3 -m unittest discover -s backend/tests -v` است. تست مرورگر به Playwright/Chromium نصب‌شده و fixture موقت متکی است.

## راهنمای کار برای ایجنت بعدی

1. قبل از ویرایش `git status --short` را ببینید و تغییرات از قبل موجود را متعلق به کار جاری تلقی کنید؛ reset، checkout، clean، stash یا overwrite انجام ندهید.
2. اول مستند دامنه مربوطه و قرارداد API موجود را بخوانید. منطق مالی/سفارش بین دامنه‌ها مشترک است؛ جمع‌ها را در frontend دوباره محاسبه یا دفتر جدید موازی نسازید.
3. مبالغ را integer تومان، تاریخ داخلی را مطابق مدل موجود و ورودی/نمایش شمسی، و زمان سرور را با `APP_TIMEZONE` مدیریت کنید. برای writeهای چندجدولی/رقابتی الگوی transaction و `BEGIN IMMEDIATE` موجود را بررسی کنید.
4. داده تست را در fixture دیتابیس موقت نگه دارید. فایل `.env`، DB محلی، token، secret و داده زیستی را نخوانید/منتشر نکنید مگر برای نیاز مشخص و مجاز.
5. ناوبری را با template و generator سازگار نگه دارید. اگر صفحه/بخش جدید اضافه شد، entrypoint و اتصال آن به app/settings را نیز بررسی کنید.
6. اگر قابلیت انبار موضوع کار است، ابتدا مشخص کنید هدف فقط فهرست تنظیمات است یا گردش واقعی خرید/موجودی؛ در حال حاضر بخش دوم هنوز موجود نیست.
