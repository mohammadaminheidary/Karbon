# Diagnostic tooling: use only synthetic data in KARBON_PERF_DIR.
import os,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[3] / 'backend'))
run_dir = Path(os.environ['KARBON_PERF_DIR']).resolve()
expected = run_dir / 'base.db'
assert Path(os.environ['KARBON_DATABASE_PATH']).resolve() == expected, 'Seed requires the isolated base.db'
assert not expected.exists(), 'Refusing to seed an existing database'
import app
from database import SessionLocal
from models import *
from models.order import Product, Order, OrderItem, OrderPayment
from models.member_face import MemberFace
from datetime import datetime,timedelta,timezone
from config import APP_TIMEZONE
from security.password import hash_password
from services.order_service import build_invoice
from services.reference_codes import compact_transaction_numbers
from uuid import UUID,uuid5
now=datetime.now(APP_TIMEZONE);today=now.date()
def uid(n):return str(UUID(int=n))
with SessionLocal() as db:
 db.add(User(username='customers-test',password_hash=hash_password('test-password')))
 db.add_all([Customer(id=i,customer_code=1000+i,first_name=f'مشتری {i}',last_name='آزمایشی',phone_numbers=[f'0912{i:07d}'],created_at=now-timedelta(days=i%120)) for i in range(1,1001)])
 db.add_all([Product(id=i,product_code=f'P-{i:06d}',name=f'کالا {i}',unit='عدد',price=10000+i*100,stock=10000 if i%5 else None) for i in range(1,251)])
 db.add_all([BankAccount(id=i,name='بانک ملت',bank='mellat',account_number=f'perf-{i}',opening_balance=1000000) for i in range(1,21)])
 db.add_all([ExpenseCategory(id=i,title=f'هزینه {i}',display_code=i) for i in range(1,11)])
 db.add_all([DocumentAccount(id=i,code=f'D-{i:06d}',title=f'حساب سند {i}',kind='expense') for i in range(1,6)])
 db.add_all([Member(id=i,first_name=f'عضو {i}',last_name='آزمایشی') for i in range(1,31)])
 db.flush()
 orders=[]
 for i in range(1,1001):
  day=today-timedelta(days=i%90);cid=(i-1)%1000+1
  order=Order(id=i,request_id=uid(i),request_fingerprint='seed',invoice_code=f'PERF-{i}',order_number=str(1000+i),customer_id=cid,invoice_date=day,payment_date=day+timedelta(days=7),subtotal=90000,discount=1000,status='active' if i%3 else 'completed')
  db.add(order);orders.append(order)
  for j in range(3):db.add(OrderItem(order_id=i,product_id=(i+j-1)%250+1,position=j+1,product_name=f'کالا {(i+j-1)%250+1}',unit='عدد',quantity=1,unit_price=30000))
  for j in range(2):
   tid=(i-1)*2+j+1
   db.add(FinancialTransaction(id=tid,request_id=uid(10000+tid),kind='income',customer_id=cid,bank_id=i%20+1,title=f'مشتری {cid} آزمایشی',account_code=str(1000+cid),amount=30000,transaction_date=day,transaction_time=f'{10+j}:30:00',time_mode='auto'))
   db.add(OrderPayment(order_id=i,transaction_id=tid,method='pos' if j==0 else 'transfer'))
 db.flush()
 for i in range(1,3001):
  income=i%3!=0
  db.add(FinancialTransaction(request_id=uid(20000+i),kind='income' if income else 'expense',customer_id=(i%1000+1) if income else None,expense_category_id=None if income else i%10+1,bank_id=i%20+1,title='تراکنش آزمایشی',account_code='1001' if income else 'E-000001',amount=1000+i,transaction_date=today-timedelta(days=i%90),transaction_time='15:30:00',time_mode='auto',description=f'شرح {i}'))
 for i in range(1,201):
  day=today-timedelta(days=i%90)
  db.add(Document(id=i,number=f'DOC-{i}',date=day,document_type='هزینه'))
  for j in range(2):db.add(FinancialTransaction(request_id=uid(30000+i*2+j),kind='expense',document_id=i,document_account_id=i%5+1,bank_id=i%20+1,title='سند هزینه',account_code=f'D-{i%5+1:06d}',amount=500,transaction_date=day,transaction_time='16:30:00',time_mode='auto'))
 db.add_all([Task(date=today-timedelta(days=i%120),title=f'کار {i}',status=['todo','in_progress','completed'][i%3]) for i in range(2000)])
 db.add_all([Attendance(member_id=i,date=today-timedelta(days=d),status='present' if (i+d)%4 else 'absent',recorded_time=now.time().replace(tzinfo=None)) for i in range(1,31) for d in range(30)])
 db.flush()
 for order in orders:order.invoice_snapshot=build_invoice(db,order)
 db.flush();compact_transaction_numbers(db);db.commit()
print('seed complete')
