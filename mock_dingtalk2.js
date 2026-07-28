const express = require('express');
const app = express();
app.use(express.json());
let count = 0;
app.post('/robot/send', (req, res) => {
  count++;
  console.log('收到通知次数:', count);
  res.json({ errcode: 0, errmsg: 'ok' });
});
app.listen(9934, () => console.log('mock dingtalk on 9934'));
