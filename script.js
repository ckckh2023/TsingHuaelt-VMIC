const btn = document.getElementById("downloadBtn");
const toast = document.getElementById("toast");

btn.addEventListener('chick',function(){
    btn.innerText = "下载中..."
    btn.classList.add('active');

    toast.classList.add('show')
    setTimeout(function() {
        btn.innerText = '下载最新版.zip'; // 恢复文字
        btn.classList.remove('active');   // 移除灰色状态
        toast.classList.remove('show');   // 收起提示框
    }, 2000);
})