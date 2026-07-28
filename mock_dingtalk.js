const express = require('express');
const app = express();
app.use(express.json());
app.post('/robot/send', (req, res) => {
  console.log('=== 收到钉钉通知 ===');
  console.log('msgtype:', req.body.msgtype);
  console.log('title:', req.body.markdown && req.body.markdown.title);
  console.log('text:', req.body.markdown && req.body.markdown.text);
  console.log('query:', req.query);
  res.json({ errcode: 0, errmsg: 'ok' });
});
app.listen(9933, () => console.log('mock dingtalk on 9933'));
