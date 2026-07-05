import path from "node:path";
import { spawn } from "node:child_process";
import * as ts from "typescript";
import { defineConfig, loadEnv } from "vite";

function typedCssModulesPlugin(rootDir: string) {
  let proc: ReturnType<typeof spawn> | undefined;

  return {
    name: "typed-css-modules",
    apply: "serve" as "serve",
    configResolved() {
      proc = spawn(
        process.platform === "win32" ? "npx.cmd" : "npx",
        ["tcm", rootDir, "-w"],
        { stdio: "inherit" },
      );
    },
    closeBundle() {
      proc?.kill();
    },
  };
}

function stripQuery(id: string) {
  const q = id.indexOf("?");
  return q === -1 ? id : id.slice(0, q);
}

function normalizeSlashes(p: string) {
  return p.replace(/\\/g, "/");
}

function getRightmostName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

function extendsAbstractComponent(node: ts.ClassLikeDeclarationBase): boolean {
  const heritage = node.heritageClauses?.find(
    (h) => h.token === ts.SyntaxKind.ExtendsKeyword,
  );
  if (!heritage) return false;

  return heritage.types.some(
    (t) => getRightmostName(t.expression) === "AbstractComponent",
  );
}

function hasTplFileMember(node: ts.ClassLikeDeclarationBase): boolean {
  return node.members.some((m) => {
    if (!ts.isPropertyDeclaration(m)) return false;
    if (!m.name) return false;
    if (ts.isIdentifier(m.name)) return m.name.text === "__tplFile";
    if (ts.isStringLiteral(m.name)) return m.name.text === "__tplFile";
    return false;
  });
}

export function injectTplFileIntoAbstractComponents() {
  let repoRoot = process.cwd();

  return {
    name: "inject-tplfile-into-abstractcomponent",
    enforce: "pre" as const,

    configResolved(config: { root?: string }) {
      repoRoot = config.root ? path.resolve(config.root) : process.cwd();
    },

    transform(code: string, id: string) {
      const cleanId = stripQuery(id);
      if (!cleanId.endsWith(".ts")) return null;
      if (!code.includes("AbstractComponent")) return null;

      const absFile = path.resolve(cleanId);
      const relFile = normalizeSlashes(path.relative(repoRoot, absFile));
      const inject = `\n  __tplFile = ${JSON.stringify(relFile)};\n`;

      const sf = ts.createSourceFile(
        cleanId,
        code,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );

      const classes: ts.ClassLikeDeclarationBase[] = [];

      const collect = (n: ts.Node) => {
        if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) {
          if (extendsAbstractComponent(n) && !hasTplFileMember(n)) {
            classes.push(n);
          }
        }
        ts.forEachChild(n, collect);
      };

      collect(sf);

      if (classes.length === 0) return null;

      let out = code;

      for (let i = classes.length - 1; i >= 0; i--) {
        const cls = classes[i];
        const classStart = cls.getStart(sf);
        const openBrace = out.indexOf("{", classStart);
        if (openBrace === -1) continue;

        out =
          out.slice(0, openBrace + 1) +
          inject +
          out.slice(openBrace + 1);
      }

      return { code: out };
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, "");

  return {
  root: __dirname,
  base: env.VITE_BASE_PATH ?? "/",

  plugins: [
    injectTplFileIntoAbstractComponents(),
    typedCssModulesPlugin(__dirname),
  ],

  resolve: {
    alias: {
      site: __dirname,
    },
    dedupe: ["cruzo"],
  },

  build: {
    outDir: path.resolve(__dirname, "../dist-site"),
    emptyOutDir: true,
    sourcemap: true,
  },

  server: {
    proxy: {
      "/api": {
        target: "http://localhost:8080",
        changeOrigin: true,
        ws: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  };
});
