const fs = require('fs');
const path = require('path');

const distDir = path.join(__dirname, 'dist');
const appDir = path.join(distDir, 'app');

// 1. 建立目錄
if (!fs.existsSync(distDir)) fs.mkdirSync(distDir);
if (!fs.existsSync(appDir)) fs.mkdirSync(appDir);

// 2. 複製 Node.js 執行檔
console.log('複製 Node.js 執行檔...');
fs.copyFileSync(process.execPath, path.join(distDir, 'node.exe'));

// 3. 複製原始碼與資源
const filesToCopy = ['index.js', 'db.js', 'package.json'];
const dirsToCopy = ['views', 'public'];

filesToCopy.forEach(file => {
    console.log(`複製 ${file}...`);
    fs.copyFileSync(path.join(__dirname, file), path.join(appDir, file));
});

dirsToCopy.forEach(dir => {
    console.log(`遞迴複製 ${dir}...`);
    copyDirRecursive(path.join(__dirname, dir), path.join(appDir, dir));
});

// 4. 建立啟動腳本
console.log('建立 start.bat...');
fs.writeFileSync(path.join(distDir, 'start.bat'), '@echo off\ncd /d "%~dp0"\nnode.exe app/index.js\npause');

function copyDirRecursive(src, dest) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest);
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyDirRecursive(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

console.log('基礎目錄建置完成！下一步請手動複製 node_modules 或執行部署命令。');
