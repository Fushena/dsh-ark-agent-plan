import test from 'node:test';
import assert from 'node:assert/strict';
import { trustedRouteRequest } from '../lib/route-guard.js';

// route-guard 回归（审计#2）：Origin 必须按完整 authority（host+端口）校验。
// 旧实现只比 hostname：本机其它端口的页面（sec-fetch-site=same-site）能过守卫，
// 构成 CSRF 面。合法同源（端口一致）必须继续放行。

const req = (headers) => ({ headers });

test('合法同源（端口一致）放行', () => {
  const r = trustedRouteRequest(req({
    host: '127.0.0.1:49419', origin: 'http://127.0.0.1:49419', 'sec-fetch-site': 'same-origin',
  }));
  assert.equal(r.ok, true);
});

test('审计#2：same-site 但端口不同 → 拒绝（旧实现只比 hostname 会放行）', () => {
  const r = trustedRouteRequest(req({
    host: '127.0.0.1:49419', origin: 'http://127.0.0.1:8080', 'sec-fetch-site': 'same-site',
  }));
  assert.equal(r.ok, false, `应拒绝异端口 Origin，实际：${JSON.stringify(r)}`);
});

test('Origin 端口与 Host 默认端口不一致 → 拒绝', () => {
  const r = trustedRouteRequest(req({
    host: '127.0.0.1', origin: 'http://127.0.0.1:8080', 'sec-fetch-site': 'same-site',
  }));
  assert.equal(r.ok, false);
});

test('默认端口等价：origin 无端口 vs host 显式 80 → 放行', () => {
  const r = trustedRouteRequest(req({
    host: '127.0.0.1:80', origin: 'http://127.0.0.1', 'sec-fetch-site': 'same-origin',
  }));
  assert.equal(r.ok, true);
});

test('默认端口等价：https origin 无端口 vs host 显式 443 → 放行', () => {
  const r = trustedRouteRequest(req({
    host: '127.0.0.1:443', origin: 'https://127.0.0.1', 'sec-fetch-site': 'same-origin',
  }));
  assert.equal(r.ok, true);
});

test('localhost 同源（端口一致）放行', () => {
  const r = trustedRouteRequest(req({
    host: 'localhost:49419', origin: 'http://localhost:49419', 'sec-fetch-site': 'same-origin',
  }));
  assert.equal(r.ok, true);
});

test('Origin 主机名与 Host 不同（即便都是 loopback、端口一致）→ 拒绝', () => {
  const r = trustedRouteRequest(req({
    host: '127.0.0.1:49419', origin: 'http://127.0.0.2:49419', 'sec-fetch-site': 'same-site',
  }));
  assert.equal(r.ok, false);
});

test('bind 地址同源放行；bind 地址异端口拒绝', () => {
  const ok = trustedRouteRequest(req({
    host: '192.168.1.5:50233', origin: 'http://192.168.1.5:50233', 'sec-fetch-site': 'same-origin',
  }), '192.168.1.5');
  assert.equal(ok.ok, true);
  const bad = trustedRouteRequest(req({
    host: '192.168.1.5:50233', origin: 'http://192.168.1.5:8080', 'sec-fetch-site': 'same-site',
  }), '192.168.1.5');
  assert.equal(bad.ok, false);
});

test('既有语义保持：cross-site 拒 / 无 Origin 本机直连放行 / 非 loopback Origin 拒 / null Origin 拒 / DNS rebinding Host 拒', () => {
  assert.equal(trustedRouteRequest(req({ host: '127.0.0.1:49419', origin: 'http://127.0.0.1:49419', 'sec-fetch-site': 'cross-site' })).ok, false);
  assert.equal(trustedRouteRequest(req({ host: '127.0.0.1:49419' })).ok, true);
  assert.equal(trustedRouteRequest(req({ host: '127.0.0.1:49419', origin: 'http://evil.com:49419' })).ok, false);
  assert.equal(trustedRouteRequest(req({ host: '127.0.0.1:49419', origin: 'null' })).ok, false);
  assert.equal(trustedRouteRequest(req({ host: 'evil.com', origin: 'http://evil.com' })).ok, false);
});
