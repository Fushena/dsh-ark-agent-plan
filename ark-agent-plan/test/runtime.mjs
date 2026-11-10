import { registerHooks, createRequire } from 'node:module';

/**
 * 测试运行时钩子：让插件源码里的 `@deepseek-ai/dsh-*` 引用解析到
 * 已安装的 DSH 运行时（app.asar 里的 dsh 目录）。
 *
 * 为什么需要：插件本身以 link: 方式装在 profile 下、运行时依赖全部由 DSH
 * 提供（peerDependencies），仓库里没有 node_modules；直接用 node 跑测试会
 * 报 ERR_MODULE_NOT_FOUND。这里用 module.registerHooks 把解析重定向到运行时。
 *
 * 可用环境变量覆盖运行时位置：DSH_TEST_RUNTIME（指向 app.asar 里的 dsh 目录）。
 */
const root = process.env.DSH_TEST_RUNTIME ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh';
const runtimeRequire = createRequire(`${root}/package.json`);

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@deepseek-ai/')) {
      try {
        return next(specifier, context);
      } catch (error) {
        if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
        return next(new URL(`file://${runtimeRequire.resolve(specifier)}`).href, context);
      }
    }
    return next(specifier, context);
  },
});
