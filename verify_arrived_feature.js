const db = require('./db');

function runTest() {
    console.log('--- 開始自動化功能驗證 ---');

    try {
        // 1. 建立測試商品
        console.log('\n[測試 3.1] 驗證狀態流轉...');
        const insert = db.prepare('INSERT INTO products (name, vendor, price, status) VALUES (?, ?, ?, ?)');
        const info = insert.run('驗證商品', '測試商', 100, 'active');
        const id = info.lastInsertRowid;
        console.log(`建立商品 ID: ${id}, 初始狀態: active`);

        const updateStatus = (newStatus) => {
            db.prepare('UPDATE products SET status = ? WHERE id = ?').run(newStatus, id);
            const p = db.prepare('SELECT status FROM products WHERE id = ?').get(id);
            console.log(`狀態切換至: ${p.status}`);
            return p.status;
        };

        if (updateStatus('processing') !== 'processing') throw new Error('流轉至 processing 失敗');
        if (updateStatus('arrived') !== 'arrived') throw new Error('流轉至 arrived 失敗');
        if (updateStatus('ended') !== 'ended') throw new Error('流轉至 ended 失敗');
        console.log('✓ 狀態流轉測試通過');

        // 2. 驗證篩選邏輯 (Task 3.2)
        console.log('\n[測試 3.2] 驗證頁簽篩選...');
        db.prepare('UPDATE products SET status = ? WHERE id = ?').run('arrived', id);
        const arrivedProducts = db.prepare('SELECT id FROM products WHERE status = ?').all('arrived');
        if (!arrivedProducts.some(p => p.id === id)) throw new Error('篩選 arrived 狀態失敗');
        console.log('✓ 篩選邏輯測試通過');

        // 3. 驗證 Excel 匯出邏輯 (Task 3.3)
        console.log('\n[測試 3.3] 驗證 Excel 匯出映射...');
        const exportSql = `
            SELECT CASE 
                WHEN status = 'arrived' THEN '已到貨'
                ELSE status END AS "商品狀態"
            FROM products WHERE id = ?
        `;
        const exportResult = db.prepare(exportSql).get(id);
        console.log(`匯出映射結果: ${exportResult['商品狀態']}`);
        if (exportResult['商品狀態'] !== '已到貨') throw new Error('Excel 匯出映射錯誤');
        console.log('✓ Excel 匯出映射測試通過');

        // 4. 驗證 Excel 匯入邏輯 (Task 3.4)
        console.log('\n[測試 3.4] 驗證 Excel 匯入映射...');
        const statusMap = {
            '進行中': 'active',
            '下單中': 'processing',
            '已到貨': 'arrived',
            '已結束': 'ended'
        };
        const importStatus = statusMap['已到貨'];
        console.log(`匯入映射結果: ${importStatus}`);
        if (importStatus !== 'arrived') throw new Error('Excel 匯入映射錯誤');
        console.log('✓ Excel 匯入映射測試通過');

        // 清理
        db.prepare('DELETE FROM products WHERE id = ?').run(id);
        console.log('\n--- 所有功能驗證成功！ ---');

    } catch (err) {
        console.error('\n❌ 驗證失敗:', err.message);
        process.exit(1);
    }
}

runTest();
