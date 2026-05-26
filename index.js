const express = require('express');
const path = require('path');
const db = require('./db');
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });
const app = express();
const port = 3018;

// 設定 EJS 作為模板引擎
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// 設定靜態資源目錄
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/**
 * 獲取日期區間的 SQL 條件與參數
 */
function getDateRangeCondition(req) {
    const { date_from, date_to } = req.query;
    let conditions = [];
    let params = [];

    if (date_from) {
        conditions.push("o.created_at >= ?");
        params.push(`${date_from} 00:00:00`);
    }
    if (date_to) {
        conditions.push("o.created_at <= ?");
        params.push(`${date_to} 23:59:59`);
    }

    return {
        sql: conditions.length > 0 ? ` AND ${conditions.join(" AND ")} ` : "",
        params,
        date_from,
        date_to
    };
}

// 首頁路徑 (商品列表)
app.get('/', (req, res) => {
    const { start_from, start_to, end_from, end_to, status } = req.query;
    
    // 預設狀態為 active，若 status 為 'all' 則不加狀態條件
    const currentStatus = status || 'active';
    
    let sql = 'SELECT * FROM products WHERE 1=1';
    const params = [];

    if (currentStatus !== 'all') {
        sql += ' AND status = ?';
        params.push(currentStatus);
    }

    if (start_from) {
        sql += ' AND start_date >= ?';
        params.push(start_from);
    }
    if (start_to) {
        sql += ' AND start_date <= ?';
        params.push(start_to);
    }
    if (end_from) {
        sql += ' AND end_date >= ?';
        params.push(end_from);
    }
    if (end_to) {
        sql += ' AND end_date <= ?';
        params.push(end_to);
    }

    sql += ' ORDER BY start_date DESC'; // 預設依上架日期排序

    const products = db.prepare(sql).all(...params);
    res.render('products', { 
        title: '商品管理', 
        products,
        filters: { start_from, start_to, end_from, end_to, status: currentStatus }
    });
});

// 新增商品頁面
app.get('/products/new', (req, res) => {
    res.render('product_form', { title: '新增商品', product: null });
});

// 匯出整合性的商品與訂單 Excel (商品管理頁面使用)
app.get('/products/export', (req, res) => {
    const xlsx = require('xlsx');

    // 查詢所有商品及其訂單明細
    const sql = `
        SELECT
            p.id AS "商品ID",
            o.id AS "訂單ID",
            p.name AS "商品名稱",
            p.price AS "單價",
            p.start_date AS "上架日期",
            p.end_date AS "結單日期",
            CASE WHEN p.status = 'active' THEN '進行中'
                 WHEN p.status = 'processing' THEN '下單中'
                 WHEN p.status = 'ended' THEN '已結束'
                 ELSE p.status END AS "商品狀態",
            o.customer_name AS "客戶名稱",
            o.options AS "選項",
            o.quantity AS "數量",
            (o.quantity * p.price) AS "小計",
            CASE WHEN o.payment_status = 'paid' THEN '已付款' 
                 WHEN o.payment_status = 'unpaid' THEN '未付款'
                 ELSE '' END AS "付款狀態",
            COALESCE(o.order_time, o.created_at) AS "訂購時間"
        FROM
            products p
        LEFT JOIN
            orders o ON p.id = o.product_id
        ORDER BY
            p.name, o.created_at DESC
    `;

    const data = db.prepare(sql).all();

    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.json_to_sheet(data);

    // 設定基本的欄位寬度
    const wscols = [
        { wch: 0 },  // 商品ID (隱藏)
        { wch: 0 },  // 訂單ID (隱藏)
        { wch: 25 }, // 商品名稱
        { wch: 10 }, // 單價
        { wch: 15 }, // 上架日期
        { wch: 15 }, // 結單日期
        { wch: 10 }, // 商品狀態
        { wch: 15 }, // 客戶名稱
        { wch: 20 }, // 選項
        { wch: 8 },  // 數量
        { wch: 12 }, // 小計
        { wch: 10 }, // 付款狀態
        { wch: 20 }  // 訂購時間
    ];
    ws['!cols'] = wscols;

    xlsx.utils.book_append_sheet(wb, ws, "商品訂單整合報表");

    const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="products_orders_integrated.xlsx"');
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
});

// 匯入整合報表並更新資料庫
app.post('/products/import', upload.single('excel_file'), (req, res) => {
    if (!req.file) {
        return res.status(400).send('請選擇要上傳的檔案');
    }

    const xlsx = require('xlsx');
    const fs = require('fs');

    try {
        const workbook = xlsx.readFile(req.file.path);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const data = xlsx.utils.sheet_to_json(worksheet);

        // 使用交易處理更新
        const updateTransaction = db.transaction((rows) => {
            let productsUpdated = new Set();
            let ordersUpdatedCount = 0;

            for (const row of rows) {
                const productId = row['商品ID'];
                const orderId = row['訂單ID'];

                // 更新商品資訊 (若有商品ID)
                if (productId) {
                    const price = parseFloat(row['單價']);
                    if (!isNaN(price)) {
                        db.prepare(`
                            UPDATE products 
                            SET name = ?, price = ?, start_date = ?, end_date = ?
                            WHERE id = ?
                        `).run(
                            row['商品名稱'], 
                            price, 
                            row['上架日期'], 
                            row['結單日期'], 
                            productId
                        );
                        productsUpdated.add(productId);
                    }
                }

                // 更新訂單資訊 (若有訂單ID)
                if (orderId) {
                    const quantity = parseInt(row['數量']);
                    if (!isNaN(quantity)) {
                        db.prepare(`
                            UPDATE orders 
                            SET customer_name = ?, options = ?, quantity = ?, payment_status = ?, order_time = ?
                            WHERE id = ?
                        `).run(
                            row['客戶名稱'],
                            row['選項'],
                            quantity,
                            row['付款狀態'] === '已付款' ? 'paid' : 'unpaid',
                            row['訂購時間'],
                            orderId
                        );
                        ordersUpdatedCount++;
                    }
                }
            }
            return { productsCount: productsUpdated.size, ordersCount: ordersUpdatedCount };
        });

        const result = updateTransaction(data);

        // 刪除臨時檔案
        fs.unlinkSync(req.file.path);

        res.send(`匯入成功！已更新 ${result.productsCount} 項商品，${result.ordersCount} 筆訂單。`);
    } catch (error) {
        console.error('匯入出錯:', error);
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).send('匯入失敗：' + error.message);
    }
});

// 儲存新商品
app.post('/products', (req, res) => {

    const { name, vendor, price, start_date, end_date } = req.body;
    db.prepare('INSERT INTO products (name, vendor, price, start_date, end_date) VALUES (?, ?, ?, ?, ?)')
        .run(name, vendor, price, start_date, end_date);
    res.redirect('/');
});

// 編輯商品頁面
app.get('/products/:id/edit', (req, res) => {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    res.render('product_form', { title: '編輯商品', product });
});

// 更新商品
app.post('/products/:id', (req, res) => {
    const { name, vendor, price, start_date, end_date, status } = req.body;
    db.prepare('UPDATE products SET name = ?, vendor = ?, price = ?, start_date = ?, end_date = ?, status = ? WHERE id = ?')
        .run(name, vendor, price, start_date, end_date, status, req.params.id);
    res.redirect('/');
});

// 刪除商品
app.post('/products/:id/delete', (req, res) => {
    db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
    res.redirect('/');
});

// 切換商品狀態
app.post('/products/:id/status', (req, res) => {
    const { status } = req.body;
    db.prepare('UPDATE products SET status = ? WHERE id = ?').run(status, req.params.id);
    res.redirect(req.header('Referer') || '/');
});

// 舊的 toggle 路由保留或導向新邏輯 (為了相容性，我們改為支援多種狀態)
app.post('/products/:id/toggle', (req, res) => {
    const product = db.prepare('SELECT status FROM products WHERE id = ?').get(req.params.id);
    const newStatus = product.status === 'active' ? 'ended' : 'active';
    db.prepare('UPDATE products SET status = ? WHERE id = ?').run(newStatus, req.params.id);
    res.redirect(req.header('Referer') || '/');
});

// 訂單輸入頁面 (針對特定商品)
app.get('/products/:id/order', (req, res) => {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    const orders = db.prepare('SELECT * FROM orders WHERE product_id = ? ORDER BY created_at DESC').all(req.params.id);
    res.render('order_form', { title: `訂單輸入 - ${product.name}`, product, orders });
});

// 儲存新訂單
app.post('/products/:id/order', (req, res) => {
    const { customer_name, quantity, options, order_time } = req.body;
    db.prepare('INSERT INTO orders (product_id, customer_name, quantity, options, order_time) VALUES (?, ?, ?, ?, ?)')
        .run(req.params.id, customer_name, quantity, options, order_time ? order_time.replace('T', ' ') : null);
    res.redirect(`/products/${req.params.id}/order`);
});

// 獲取單筆訂單 JSON (用於編輯)
app.get('/orders/:id', (req, res) => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (order) {
        res.json(order);
    } else {
        res.status(404).json({ error: '訂單不存在' });
    }
});

// 更新訂單
app.post('/orders/:id', (req, res) => {
    const { customer_name, quantity, options, order_time } = req.body;
    const order = db.prepare('SELECT product_id FROM orders WHERE id = ?').get(req.params.id);
    if (order) {
        db.prepare('UPDATE orders SET customer_name = ?, quantity = ?, options = ?, order_time = ? WHERE id = ?')
            .run(customer_name, quantity, options, order_time ? order_time.replace('T', ' ') : null, req.params.id);
        res.redirect(`/products/${order.product_id}/order`);
    } else {
        res.redirect('/');
    }
});

// 刪除訂單
app.post('/orders/:id/delete', (req, res) => {
    const order = db.prepare('SELECT product_id FROM orders WHERE id = ?').get(req.params.id);
    if (order) {
        db.prepare('DELETE FROM orders WHERE id = ?').run(req.params.id);
        res.redirect(`/products/${order.product_id}/order`);
    } else {
        res.redirect('/');
    }
});

// 切換訂單付款狀態
app.post('/orders/:id/toggle-payment', (req, res) => {
    const order = db.prepare('SELECT payment_status FROM orders WHERE id = ?').get(req.params.id);
    if (order) {
        const newStatus = order.payment_status === 'paid' ? 'unpaid' : 'paid';
        db.prepare('UPDATE orders SET payment_status = ? WHERE id = ?').run(newStatus, req.params.id);
        res.redirect(req.header('Referer') || '/');
    } else {
        res.status(404).send('訂單不存在');
    }
});

// 統計儀表板
app.get('/dashboard', (req, res) => {
    const { sql: dateSql, params: dateParams, date_from, date_to } = getDateRangeCondition(req);

    const productStats = db.prepare(`
        SELECT p.id, p.name, p.price, 
               SUM(o.quantity) as total_quantity, 
               SUM(o.quantity * p.price) as total_amount
        FROM products p
        LEFT JOIN orders o ON p.id = o.product_id ${dateSql}
        GROUP BY p.id
    `).all(dateParams);

    const customerStats = db.prepare(`
        SELECT o.customer_name, 
               COUNT(*) as item_count, 
               SUM(o.quantity) as total_quantity,
               SUM(o.quantity * p.price) as total_spend
        FROM orders o
        JOIN products p ON o.product_id = p.id
        WHERE 1=1 ${dateSql}
        GROUP BY o.customer_name
    `).all(dateParams);

    const optionStats = db.prepare(`
        SELECT p.name, o.options, SUM(o.quantity) as total_quantity
        FROM orders o
        JOIN products p ON o.product_id = p.id
        WHERE o.options IS NOT NULL AND o.options != '' ${dateSql}
        GROUP BY p.id, o.options
    `).all(dateParams);

    const grandTotal = db.prepare(`
        SELECT SUM(o.quantity * p.price) as grand_total
        FROM products p
        LEFT JOIN orders o 
            ON p.id = o.product_id ${dateSql}
    `).get(dateParams);

    // 計算 Top 3 排行數據
    const topProductsQty = [...productStats]
        .filter(p => p.total_quantity > 0)
        .sort((a, b) => b.total_quantity - a.total_quantity)
        .slice(0, 3);
    
    const topProductsAmount = [...productStats]
        .filter(p => p.total_amount > 0)
        .sort((a, b) => b.total_amount - a.total_amount)
        .slice(0, 3);

    const topCustomersQty = [...customerStats]
        .filter(c => c.total_quantity > 0)
        .sort((a, b) => b.total_quantity - a.total_quantity)
        .slice(0, 3);

    const topCustomersAmount = [...customerStats]
        .filter(c => c.total_spend > 0)
        .sort((a, b) => b.total_spend - a.total_spend)
        .slice(0, 3);

    res.render('dashboard', { 
        title: '統計儀表板', 
        productStats, 
        customerStats, 
        optionStats, 
        date_from, 
        date_to, 
        grandTotal,
        topData: {
            products: { qty: topProductsQty, amount: topProductsAmount },
            customers: { qty: topCustomersQty, amount: topCustomersAmount }
        }
    });
});

// 匯出 Excel 報表
app.get('/export', (req, res) => {
    const xlsx = require('xlsx');
    const { sql: dateSql, params: dateParams } = getDateRangeCondition(req);

    const productStats = db.prepare(`
        SELECT p.name as "商品名稱", p.price as "單價", 
               IFNULL(SUM(o.quantity), 0) as "總數量", 
               IFNULL(SUM(o.quantity * p.price), 0) as "總金額"
        FROM products p
        LEFT JOIN orders o ON p.id = o.product_id ${dateSql}
        GROUP BY p.id
    `).all(dateParams);

    const customerStats = db.prepare(`
        SELECT customer_name as "客戶名稱", 
               COUNT(*) as "商品種類數", 
               SUM(quantity) as "總數量",
               SUM(quantity * price) as "總消費金額"
        FROM orders o
        JOIN products p ON o.product_id = p.id
        WHERE 1=1 ${dateSql}
        GROUP BY customer_name
    `).all(dateParams);

    const wb = xlsx.utils.book_new();
    const ws1 = xlsx.utils.json_to_sheet(productStats);
    const ws2 = xlsx.utils.json_to_sheet(customerStats);

    xlsx.utils.book_append_sheet(wb, ws1, "商品統計");
    xlsx.utils.book_append_sheet(wb, ws2, "客戶統計");

    const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="report.xlsx"');
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
});

// 匯出客戶報表 Excel
app.get('/customer-report/export', (req, res) => {
    const xlsx = require('xlsx');
    const selectedCustomer = req.query.customer;
    const { sql: dateSql, params: dateParams } = getDateRangeCondition(req);

    let sql = `
        SELECT
            COALESCE(o.order_time, o.created_at) AS "訂購時間",
            o.customer_name AS "客戶名稱",
            p.name AS "商品名稱",
            o.options AS "選項",
            o.quantity AS "數量",
            p.price AS "單價",
            o.quantity * p.price AS "小計",
            CASE WHEN o.payment_status = 'paid' THEN '已付款' ELSE '未付款' END AS "付款狀態"
        FROM
            orders o
        JOIN
            products p ON o.product_id = p.id
        WHERE 1=1 ${dateSql}
    `;

    let params = [...dateParams];
    if (selectedCustomer) {
        sql += ` AND o.customer_name = ? `;
        params.push(selectedCustomer);
    }

    sql += ` ORDER BY o.customer_name, o.created_at DESC `;

    const orders = db.prepare(sql).all(params);

    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.json_to_sheet(orders);
    xlsx.utils.book_append_sheet(wb, ws, "客戶訂單明細");

    const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const filename = selectedCustomer ? `customer_report_${selectedCustomer}.xlsx` : 'customer_report_all.xlsx';
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
});

// 匯出商品報表 Excel
app.get('/product-report/export', (req, res) => {
    const xlsx = require('xlsx');
    const selectedProductId = req.query.product_id;
    const { sql: dateSql, params: dateParams } = getDateRangeCondition(req);

    let sql = `
        SELECT
            COALESCE(o.order_time, o.created_at) AS "訂購時間",
            p.name AS "商品名稱",
            o.customer_name AS "客戶名稱",
            o.options AS "選項",
            o.quantity AS "數量",
            p.price AS "單價",
            o.quantity * p.price AS "小計",
            CASE WHEN o.payment_status = 'paid' THEN '已付款' ELSE '未付款' END AS "付款狀態"
        FROM
            orders o
        JOIN
            products p ON o.product_id = p.id
        WHERE 1=1 ${dateSql}
    `;

    let params = [...dateParams];
    if (selectedProductId && selectedProductId !== 'all') {
        sql += ` AND o.product_id = ? `;
        params.push(selectedProductId);
    }

    sql += ` ORDER BY o.created_at DESC `;

    const orders = db.prepare(sql).all(params);

    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.json_to_sheet(orders);
    xlsx.utils.book_append_sheet(wb, ws, "商品訂單明細");

    const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    let filename = 'product_report_all.xlsx';
    if (selectedProductId && selectedProductId !== 'all') {
        const product = db.prepare('SELECT name FROM products WHERE id = ?').get(selectedProductId);
        if (product) filename = `product_report_${product.name}.xlsx`;
    }

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
});

app.get('/customer-report', (req, res) => {
    const allCustomers = db.prepare('SELECT DISTINCT customer_name FROM orders ORDER BY customer_name').all();
    const selectedCustomer = req.query.customer;
    const { sql: dateSql, params: dateParams, date_from, date_to } = getDateRangeCondition(req);

    let sql = `
        SELECT
            o.customer_name,
            o.id AS order_id,
            o.options,
            o.quantity,
            o.payment_status,
            o.order_time,
            o.created_at,
            p.name AS product_name,
            p.price AS product_price,
            o.quantity * p.price AS item_total
        FROM
            orders o
        JOIN
            products p ON o.product_id = p.id
        WHERE 1=1 ${dateSql}
    `;

    let params = [...dateParams];
    if (selectedCustomer) {
        sql += ` AND o.customer_name = ? `;
        params.push(selectedCustomer);
    }

    sql += ` ORDER BY o.customer_name, COALESCE(o.order_time, o.created_at) DESC `;

    const customerOrders = db.prepare(sql).all(params);

    // 處理資料以按客戶名稱分組
    const groupedOrders = customerOrders.reduce((acc, item) => {
        if (!acc[item.customer_name]) {
            acc[item.customer_name] = {
                customer_name: item.customer_name,
                total_spend: 0,
                paid_total: 0,
                unpaid_total: 0,
                orders: []
            };
        }
        acc[item.customer_name].orders.push(item);
        acc[item.customer_name].total_spend += item.item_total;
        if (item.payment_status === 'paid') {
            acc[item.customer_name].paid_total += item.item_total;
        } else {
            acc[item.customer_name].unpaid_total += item.item_total;
        }
        return acc;
    }, {});

    const customers = Object.values(groupedOrders).sort((a, b) => a.customer_name.localeCompare(b.customer_name));

    res.render('customer_report', { title: '客戶報表', customers, allCustomers, selectedCustomer, date_from, date_to });
});

app.get('/product-report', (req, res) => {
    const allProducts = db.prepare('SELECT id, name FROM products ORDER BY name').all();
    const selectedProductId = req.query.product_id;
    const { sql: dateSql, params: dateParams, date_from, date_to } = getDateRangeCondition(req);

    let orders = [];
    let product = null;

    if (selectedProductId && selectedProductId !== 'all') {
        product = db.prepare('SELECT * FROM products WHERE id = ?').get(selectedProductId);

        let sql = `
            SELECT 
                o.id AS order_id,
                o.customer_name,
                o.quantity,
                o.options,
                o.payment_status,
                o.order_time,
                o.created_at,
                p.price AS product_price,
                o.quantity * p.price AS item_total,
                p.name AS product_name
            FROM orders o
            JOIN products p ON o.product_id = p.id
            WHERE o.product_id = ? ${dateSql}
            ORDER BY o.created_at DESC
        `;
        orders = db.prepare(sql).all(selectedProductId, ...dateParams);
    } else {
        // 查詢所有商品的訂單
        let sql = `
            SELECT 
                o.id AS order_id,
                o.customer_name,
                o.quantity,
                o.options,
                o.payment_status,
                o.order_time,
                o.created_at,
                p.price AS product_price,
                o.quantity * p.price AS item_total,
                p.name AS product_name
            FROM orders o
            JOIN products p ON o.product_id = p.id
            WHERE 1=1 ${dateSql}
            ORDER BY p.name, COALESCE(o.order_time, o.created_at) DESC
        `;
        const allOrders = db.prepare(sql).all(...dateParams);
        
        // 處理資料以按商品名稱分組
        const groupedOrders = allOrders.reduce((acc, item) => {
            if (!acc[item.product_name]) {
                acc[item.product_name] = {
                    product_name: item.product_name,
                    orders: []
                };
            }
            acc[item.product_name].orders.push(item);
            return acc;
        }, {});
        
        orders = Object.values(groupedOrders);
    }

    res.render('product_report', {
        title: '商品報表',
        allProducts,
        selectedProductId: selectedProductId || 'all',
        orders,
        product,
        date_from,
        date_to
    });
});

app.listen(port, () => {
    console.log(`伺服器正執行於 http://localhost:${port}`);
});
