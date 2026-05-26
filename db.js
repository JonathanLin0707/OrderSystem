const Database = require('better-sqlite3');
const path = require('path');

// 判斷是否在打包環境 (pkg 或 SEA)
// 在 SEA 中，我們通常檢查是否被封裝，或直接依賴 execPath
const isPackaged = process.pkg || process.hasOwnProperty('sea'); 

const dbPath = isPackaged 
    ? path.join(path.dirname(process.execPath), 'orders.db')
    : 'orders.db';

const db = new Database(dbPath);

// 初始化資料表
db.exec(`
    CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        vendor TEXT,
        price REAL NOT NULL,
        start_date TEXT,
        end_date TEXT,
        status TEXT DEFAULT 'active'
    );

    CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER,
        customer_name TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        options TEXT,
        payment_status TEXT DEFAULT 'unpaid',
        order_time TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (product_id) REFERENCES products(id)
    );
`);

// 嘗試新增欄位 (針對現有資料庫)
try {
    db.exec("ALTER TABLE orders ADD COLUMN payment_status TEXT DEFAULT 'unpaid'");
} catch (e) {}

try {
    db.exec("ALTER TABLE orders ADD COLUMN order_time TEXT");
} catch (e) {}

module.exports = db;
