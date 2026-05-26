const db = require('./db');

try {
    // 1. 測試商品新增
    console.log('測試商品新增...');
    const insertProd = db.prepare('INSERT INTO products (name, price) VALUES (?, ?)');
    const info = insertProd.run('測試商品', 100);
    const prodId = info.lastInsertRowid;

    // 2. 測試訂單新增
    console.log('測試訂單新增...');
    const insertOrder = db.prepare('INSERT INTO orders (product_id, customer_name, quantity) VALUES (?, ?, ?)');
    insertOrder.run(prodId, '測試客戶A', 2);
    insertOrder.run(prodId, '測試客戶B', 3);

    // 3. 測試統計查詢
    console.log('測試統計查詢...');
    const stats = db.prepare(`
        SELECT SUM(o.quantity) as total_qty, SUM(o.quantity * p.price) as total_amt
        FROM products p JOIN orders o ON p.id = o.product_id
        WHERE p.id = ?
    `).get(prodId);

    console.log('結果:', stats);

    if (stats.total_qty === 5 && stats.total_amt === 500) {
        console.log('✅ 統計驗證成功！');
    } else {
        console.error('❌ 統計驗證失敗', stats);
        process.exit(1);
    }

    // 清理測試資料
    db.prepare('DELETE FROM orders WHERE product_id = ?').run(prodId);
    db.prepare('DELETE FROM products WHERE id = ?').run(prodId);
    console.log('清理完成。');

} catch (err) {
    console.error('測試過程中發生錯誤:', err);
    process.exit(1);
}
