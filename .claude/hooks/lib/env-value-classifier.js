// HiveMind — env-value leak classifier (pure string analysis, runs nothing).
//
// findEnvValueLeak(command) answers one question: would this Bash command
// string PRINT environment VALUES (secrets) into the transcript? It returns
// { rule, reason } for the first leaking form it finds, or null.
//
// Fail-closed by design: when a form cannot be proven names-only it is
// refused. The names-only alternatives (env-names.sh, count/list/quiet grep,
// docker inspect with a names-only or non-env template) stay allowed.
//
// How a command is read:
//   1. The string is tokenised like a shell would (quotes, escapes,
//      separators ; | & ( ) newline, redirects, heredocs). Separators inside
//      quotes do not split, so `git commit -m "fix; env"` is one argument.
//   2. Each segment is judged by its command word. Wrapper commands (ssh,
//      sudo, bash/sh -c, xargs, docker exec/run, kubectl, ...) are unwrapped:
//      every suffix of their arguments is judged as a command of its own, and
//      every quoted multi-word argument and heredoc body is analysed as a
//      nested command string.
//   3. $( ... ) and backtick substitutions are analysed as nested commands.

'use strict';

const MAX_DEPTH = 6;

const READERS = new Set([
  'cat', 'less', 'more', 'head', 'tail', 'bat', 'batcat', 'strings',
  'sed', 'awk', 'gawk', 'mawk', 'tac', 'nl', 'od', 'xxd', 'base64', 'rev',
  'paste', 'column', 'sort', 'uniq', 'diff', 'cut', 'jq', 'yq', 'view',
]);
const GREPS = new Set(['grep', 'egrep', 'fgrep', 'zgrep', 'rg', 'ag', 'ack']);
const WRAPPERS = new Set([
  'ssh', 'sudo', 'doas', 'su', 'runuser', 'bash', 'sh', 'zsh', 'dash', 'ksh',
  'eval', 'xargs', 'timeout', 'nohup', 'nice', 'ionice', 'stdbuf', 'watch',
  'command', 'exec', 'setsid', 'chroot', 'nsenter', 'flock', 'parallel',
  'kubectl', 'oc', 'lxc',
]);
const CONTAINER_CLIS = new Set(['docker', 'podman', 'nerdctl', 'docker-compose']);
const INTERPRETERS = /^(node|nodejs|bun|deno|python[\d.]*|perl|ruby)$/;
// Variable names that usually hold a credential.
const SECRET_NAME = /(URL|PASS|SECRET|TOKEN|KEY|DSN|PWD|CREDENTIAL)/i;
// Named printenv is an explicit allowlist (fail-closed), not the SECRET_NAME
// denylist echo uses: only these names may be printed by it.
const PRINTENV_ALLOWED = new Set([
  'ENGRAM_SLUG', 'ENGRAM_SESSION_ID', 'ENGRAM_DEVICE_ID',
  'HOME', 'USER', 'SHELL', 'PATH', 'PWD', 'LANG', 'TERM',
]);
// Wrappers that append operands read from stdin / a file after the argv the
// classifier judged: a printenv beneath them cannot be analysed.
const OPERAND_APPENDERS = new Set(['xargs', 'parallel']);
// Directories whose contents are source, not deployment config: a recursive
// search for a secret-like word there is a code search.
const SOURCE_DIRS = new Set([
  'src', 'lib', 'test', 'tests', '__tests__', 'spec', 'docs', 'doc',
  'node_modules', 'coverage',
]);
const NON_ENV_INSPECT = new Set([
  'network', 'volume', 'plugin', 'context', 'node', 'secret', 'config',
  'builder', 'buildx', 'manifest', 'trust', 'swarm',
]);
const SKIP_LEAD = new Set(['!', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', 'time', '{', '}']);

const REASONS = {
  'docker-inspect-no-format':
    'docker inspect without --format prints the whole config, including every env value',
  'docker-inspect-env':
    'this docker inspect --format template can print env values (only names-only templates or ones that do not touch the env are allowed)',
  'env-print': '`env` with no command prints every variable with its value',
  printenv: '`printenv` with no variable name prints every variable with its value',
  'printenv-named':
    '`printenv` is limited to ENGRAM_SLUG, ENGRAM_SESSION_ID, ENGRAM_DEVICE_ID, HOME, USER, SHELL, PATH, PWD, LANG and TERM (optionally with -0/--null; not under xargs/parallel; no command substitution among its operands); for any other variable use `echo "$NAME"`',
  'export-print': 'bare `export` / `export -p` prints every exported variable with its value',
  'set-print': 'bare `set` prints every shell variable with its value',
  'declare-print': '`declare -p` / `declare -x` prints variable values',
  'proc-environ': 'reading /proc/*/environ prints a process environment with its values',
  'env-file-read': 'reading an env file with this command prints its values',
  'env-file-grep':
    'grep on an env file prints matching lines with their values (only -c, -l, -L, -q are allowed)',
  'env-file-redirect': 'feeding an env file to a command on stdin can print its values',
  'env-file-grep-recursive':
    'a recursive search for a secret-like word can print values from env files in the tree (exclude them with --exclude=\'.env*\' / rg -g \'!.env*\', or use -l / -c / -q)',
  'compose-config': '`docker compose config` prints the resolved config with every env value',
  'secret-expansion': 'expanding a secret-like variable prints its value',
  'inline-env-dump': 'inline code that dumps the process environment or a secret-like variable prints values',
  'git-env-file': 'git show/diff/log -p of an env file prints its values (history included)',
  'systemd-environment': 'systemctl show-environment / show -p Environment prints unit environment values',
  'too-deep': 'command nesting is too deep to analyse, refused (fail-closed)',
};

const GUIDANCE =
  'Print variable NAMES only, never values: `grep -c` / `grep -q` to test presence, ' +
  '`cut -s -d= -f1 FILE | grep -v \'^#\'` for a file, a names-only docker template ' +
  '(`{{range .Config.Env}}{{index (split . "=") 0}}{{"\\n"}}{{end}}`), ' +
  'or ops/env-names.sh where the project ships it.';

// ─── env file recognition ───────────────────────────────────────────────────

const TEMPLATE_SUFFIX = /\.(example|sample|template|dist|defaults?)$/i;
const CODE_SUFFIX = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|md|sh|bash|cfg)$/i;

function isEnvFile(word) {
  if (typeof word !== 'string' || !word) return false;
  // Judge both the word and the value of an option (--env-file=.env, FILE=.env).
  const candidates = [word];
  const eq = word.lastIndexOf('=');
  if (eq > 0 && eq < word.length - 1) candidates.push(word.slice(eq + 1));
  return candidates.some((c) => {
    const base = c.replace(/\/+$/, '').split('/').pop();
    if (!base) return false;
    if (/[*?[]/.test(base)) return globMatchesEnvFile(base);
    if (TEMPLATE_SUFFIX.test(base)) return false;
    if (/^\.env/i.test(base) || /\.env$/i.test(base)) return true; // .env*, *.env
    if (/env\./i.test(base) && !CODE_SUFFIX.test(base)) return true; // *env.*
    return false;
  });
}

// A shell glob targets an env file when it can match one of the usual names
// and names "env" itself or a dotfile prefix (a bare `*` never matches a
// dotfile, and `src/*` is not an env read).
function globToRegex(glob, sep) {
  try {
    return new RegExp(
      '^' +
        glob
          .replace(/[.+^${}()|\\]/g, '\\$&')
          .replace(/\*/g, sep ? '[^/]*' : '.*')
          .replace(/\?/g, sep ? '[^/]' : '.') +
        '$'
    );
  } catch {
    return null;
  }
}

// Names a --include / --exclude glob is judged against: it is the names it
// matches that decide, not how the glob looks.
const ENV_SAMPLE_NAMES = ['.env', '.env.local', '.env.deploy.bak-x', '.env.auth-service.save', 'prod.env'];

function globMatchesEnvFile(glob) {
  const re = globToRegex(glob, true);
  if (!re) return false;
  const names = glob.startsWith('.')
    ? ['.env', '.env.local', '.env.production']
    : ['prod.env', 'app.env.bak', 'x.env.local'];
  if (!names.some((n) => re.test(n))) return false;
  return glob.startsWith('.') || /env/i.test(glob);
}

// ─── tokeniser ──────────────────────────────────────────────────────────────

function newSeg() {
  return { tokens: [], redirIn: [], heredocs: [] };
}

function splitSegments(str) {
  const segs = [];
  let seg = newSeg();
  let tok = null;
  let q = null;
  const pending = [];
  const n = str.length;
  let i = 0;

  const pushTok = () => {
    if (tok !== null) {
      seg.tokens.push(tok);
      tok = null;
    }
  };
  const endSeg = () => {
    pushTok();
    if (seg.tokens.length || seg.redirIn.length || seg.heredocs.length) segs.push(seg);
    seg = newSeg();
  };
  const readWord = () => {
    let w = '';
    while (i < n && !/[\s;|&()<>`]/.test(str[i])) {
      if (str[i] === "'" || str[i] === '"') {
        const quote = str[i++];
        while (i < n && str[i] !== quote) w += str[i++];
        i++;
      } else {
        w += str[i++];
      }
    }
    return w;
  };

  while (i < n) {
    const c = str[i];
    if (q === "'") {
      if (c === "'") q = null;
      else tok += c;
      i++;
      continue;
    }
    if (q === '"') {
      if (c === '\\' && i + 1 < n) {
        tok += str[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') q = null;
      else tok += c;
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      if (tok === null) tok = '';
      i++;
      continue;
    }
    if (c === '\\') {
      if (i + 1 < n && str[i + 1] === '\n') {
        i += 2;
        continue;
      }
      if (i + 1 < n) tok = (tok === null ? '' : tok) + str[i + 1];
      i += 2;
      continue;
    }
    if (c === '\n') {
      endSeg();
      i++;
      for (const p of pending.splice(0)) {
        const lines = [];
        while (i < n) {
          let e = str.indexOf('\n', i);
          if (e === -1) e = n;
          const line = str.slice(i, e);
          i = e + 1;
          if (line.trim() === p.delim) break;
          lines.push(line);
        }
        p.seg.heredocs.push(lines.join('\n'));
      }
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      pushTok();
      i++;
      continue;
    }
    if (c === '>') {
      if (tok !== null && /^\d+$/.test(tok)) tok = null;
      pushTok();
      i++;
      while (i < n && (str[i] === '>' || str[i] === '|')) i++;
      if (str[i] === '&') i++;
      while (i < n && (str[i] === ' ' || str[i] === '\t')) i++;
      readWord();
      continue;
    }
    if (c === '<') {
      pushTok();
      if (str[i + 1] === '<') {
        if (str[i + 2] === '<') {
          i += 3; // here-string: the following word is an ordinary argument
          continue;
        }
        i += 2;
        if (str[i] === '-') i++;
        while (i < n && (str[i] === ' ' || str[i] === '\t')) i++;
        const delim = readWord();
        pending.push({ seg, delim });
        continue;
      }
      i++;
      if (str[i] === '(') continue; // process substitution: let ( split
      while (i < n && (str[i] === ' ' || str[i] === '\t')) i++;
      const w = readWord();
      if (w) seg.redirIn.push(w);
      continue;
    }
    if (c === ';' || c === '|' || c === '&' || c === '(' || c === ')' || c === '`') {
      endSeg();
      i++;
      continue;
    }
    tok = (tok === null ? '' : tok) + c;
    i++;
  }
  endSeg();
  // A heredoc whose terminator never appeared still carries its body.
  return segs;
}

// ─── docker inspect templates ───────────────────────────────────────────────

const NAMES_ONLY_EXPR = /\bindex\s+\(\s*split\s+[^()]*?"="\s*\)\s+0\b/g;

function templateLeaks(template) {
  const actions = template.match(/\{\{[\s\S]*?\}\}/g) || [];
  const inners = actions.map((a) =>
    a
      .slice(2, -2)
      .replace(/^-\s*|\s*-$/g, '')
      .replace(NAMES_ONLY_EXPR, 'NAME')
      .trim()
  );
  const strict = inners.some((a) => /\bEnv\b/.test(a));
  const stack = []; // true when the block rebinds dot (range / with)
  for (const a of inners) {
    // Binding the whole config (with .Config, $c := .Config) exposes its Env.
    if (/\.Config(?![.\w])/.test(a)) return true;
    const kw = (a.match(/^(range|with|if|else|end|define|block|template)\b/) || [])[1];
    if (kw === 'range' || kw === 'with' || kw === 'define' || kw === 'block') {
      stack.push(true);
      continue;
    }
    if (kw === 'if') {
      stack.push(false);
      continue;
    }
    if (kw === 'end') {
      stack.pop();
      continue;
    }
    if (kw === 'else' || kw === 'template') continue;
    if (a.includes(':=') || a === '') continue; // assignment prints nothing
    const dotRebound = stack.some(Boolean);
    if (/\bEnv\b/.test(a)) return true;
    if (/(^|[\s(|])\.(?=[\s)|]|$)/.test(a) && (strict || !dotRebound)) return true;
    if (strict && /\$\w*/.test(a)) return true;
  }
  return false;
}

function inspectTemplates(args) {
  const out = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '-f' || a === '--format') {
      if (k + 1 < args.length) out.push(args[++k]);
    } else if (a.startsWith('--format=')) {
      out.push(a.slice('--format='.length));
    } else if (/^-f./.test(a) && !a.startsWith('--')) {
      out.push(a.slice(2));
    }
  }
  return out;
}

// ─── helpers ────────────────────────────────────────────────────────────────

const baseName = (w) => String(w).split('/').pop();

// Options that consume the next argument, per tool: GNU grep and ripgrep
// differ (grep's --color takes its value only as --color=WHEN and -T takes
// none; ripgrep's -t / -T / -g / --color all take one).
const GREP_VALUED = new Set([
  '-m', '-A', '-B', '-C', '-d', '-D',
  '--max-count', '--include', '--exclude', '--exclude-dir', '--exclude-from',
  '--context', '--after-context', '--before-context', '--label', '--binary-files',
  '--devices', '--directories',
]);
const RG_VALUED = new Set([
  '-m', '-A', '-B', '-C', '-g', '-t', '-T', '-d', '-j', '-E',
  '--max-count', '--glob', '--iglob', '--type', '--type-not', '--max-depth',
  '--context', '--after-context', '--before-context', '--color', '--colors',
  '--threads', '--encoding', '--max-filesize', '--type-add',
]);
const valuedOptions = (lead) => (GREPS_RG_LIKE.has(lead) ? RG_VALUED : GREP_VALUED);
const GREPS_RG_LIKE = new Set(['rg', 'ag', 'ack']);

// Split a grep/rg argument list into its patterns and its file operands.
function grepOperands(lead, args) {
  const patterns = [];
  const files = [];
  let havePatternOpt = false;
  const positional = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '-e' || a === '--regexp') {
      havePatternOpt = true;
      if (k + 1 < args.length) patterns.push(args[++k]);
    } else if (a.startsWith('--regexp=')) {
      havePatternOpt = true;
      patterns.push(a.slice(9));
    } else if (a === '-f' || a === '--file') {
      havePatternOpt = true;
      if (k + 1 < args.length) files.push(args[++k]); // the pattern file is read
    } else if (valuedOptions(lead).has(a)) {
      k++;
    } else if (a === '--') {
      positional.push(...args.slice(k + 1));
      break;
    } else if (a.startsWith('-') && a !== '-') {
      /* flag */
    } else {
      positional.push(a);
    }
  }
  if (!havePatternOpt && positional.length) patterns.push(positional.shift());
  files.push(...positional);
  return { patterns, files };
}

function grepIsSafe(lead, args) {
  const long = new Set([
    '--count', '--files-with-matches', '--files-without-match', '--quiet', '--silent',
  ]);
  return args.some((a) => {
    if (a.startsWith('--')) return long.has(a.split('=')[0]);
    if (!/^-[A-Za-z]+$/.test(a)) return false;
    // rg -L is --follow, not "files without match".
    return lead === 'rg' ? /[clq]/.test(a) : /[clLq]/.test(a);
  });
}

// Patterns that look up code references to the environment, not values.
const CODE_REF_PATTERN = /process\.env|import\.meta\.env|Bun\.env|os\.environ|getenv|Deno\.env/;

function isRecursiveGrep(lead, args) {
  if (GREPS_RG_LIKE.has(lead)) {
    // These skip hidden and gitignored files (so env files) unless told not to.
    return args.some(
      (a) => a === '--hidden' || a === '--no-ignore' || a === '--no-ignore-vcs' || a === '--unrestricted' || /^-[A-Za-z.]*\.[A-Za-z.]*$/.test(a) || /^-u+$/.test(a) || /^-[A-Za-z]*u[A-Za-z]*$/.test(a)
    );
  }
  return args.some(
    (a) => a === '--recursive' || a === '--dereference-recursive' || /^-[A-Za-z]*[rR][A-Za-z]*$/.test(a)
  );
}

// True when the exclude globs together keep every sample env file name out of
// the search.
function excludesEnvFiles(lead, args) {
  const globs = [];
  args.forEach((a, k) => {
    const next = args[k + 1] || '';
    if (lead === 'rg') {
      if (a === '-g' || a === '--glob' || a === '--iglob') globs.push(next);
      else if (/^--(i?glob)=/.test(a)) globs.push(a.slice(a.indexOf('=') + 1));
      else if (/^-g./.test(a)) globs.push(a.slice(2));
    } else if (a === '--exclude') globs.push(next);
    else if (a.startsWith('--exclude=')) globs.push(a.slice(10));
  });
  const negated = lead === 'rg' ? globs.filter((g) => g.startsWith('!')).map((g) => g.slice(1)) : globs;
  const res = negated.map((g) => globToRegex(g, false)).filter(Boolean);
  return res.length > 0 && ENV_SAMPLE_NAMES.every((n) => res.some((re) => re.test(n)));
}

// grep --include=GLOB restricts the search to files matching GLOB; safe when
// every glob names something that is not an env file.
function includesOnlyNonEnvGlobs(lead, args) {
  if (GREPS_RG_LIKE.has(lead)) return false;
  const globs = [];
  args.forEach((a, k) => {
    if (a.startsWith('--include=')) globs.push(a.slice(10));
    else if (a === '--include' && k + 1 < args.length) globs.push(args[k + 1]);
  });
  return (
    globs.length > 0 &&
    globs.every((g) => {
      const re = globToRegex(g, false);
      return !!re && !ENV_SAMPLE_NAMES.some((n) => re.test(n));
    })
  );
}

// Only RELATIVE operands whose first segment (after an optional ./) is a
// source directory are a code search. Absolute paths, ~ and anything with a
// `..` segment are never exempt.
function insideSourceDirs(files) {
  return (
    files.length > 0 &&
    files.every((f) => {
      if (f.startsWith('/') || f.startsWith('~')) return false;
      const segs = f.replace(/^(\.\/)+/, '').split('/');
      if (segs.includes('..')) return false;
      return SOURCE_DIRS.has(segs[0]);
    })
  );
}

function inlineEnvDump(text) {
  const t = String(text);
  if (/\b(process\.env|Bun\.env)\b(?!\s*(\.\w|\[))/.test(t)) return true;
  if (/\bos\.environ\b(?!\s*(\[|\.get\())/.test(t)) return true;
  for (const m of t.matchAll(/\b(?:process\.env|Bun\.env)\s*(?:\.(\w+)|\[\s*['"`](\w+))/g)) {
    if (SECRET_NAME.test(m[1] || m[2])) return true;
  }
  for (const m of t.matchAll(/\bos\.environ\s*(?:\[|\.get\()\s*['"](\w+)|\bos\.getenv\(\s*['"](\w+)/g)) {
    if (SECRET_NAME.test(m[1] || m[2])) return true;
  }
  return false;
}

function expandsSecretVar(word) {
  for (const m of String(word).matchAll(/\$\{?([A-Za-z_]\w*)/g)) {
    if (SECRET_NAME.test(m[1])) return true;
  }
  return false;
}

// Forms that print only the key part of an env file. They must also drop what
// a multi-line value would leak: lines without a delimiter are not printed
// (cut -s, awk NF>1, sed -n ...p).
function isNamesOnlyProjection(lead, args) {
  const rest = args.filter((a) => !isEnvFile(a));
  if (lead === 'cut') {
    let sFlag = false;
    let delim = false;
    let field = false;
    for (let k = 0; k < rest.length; k++) {
      const a = rest[k];
      if (a === '-s' || a === '--only-delimited') sFlag = true;
      else if (a === '-d=' || a === '--delimiter=' || a === '--delimiter==') delim = true;
      else if (a === '-d' && rest[k + 1] === '=') {
        delim = true;
        k++;
      } else if (a === '-f1' || a === '--fields=1') field = true;
      else if (a === '-f' && rest[k + 1] === '1') {
        field = true;
        k++;
      } else return false; // --complement, other fields, -c, -b, anything else
    }
    return sFlag && delim && field;
  }
  if (lead === 'awk' || lead === 'gawk' || lead === 'mawk') {
    const prog = /^NF>1\s*\{\s*print\s+\$1\s*\}$/;
    if (rest.length === 2 && rest[0] === '-F=' && prog.test(rest[1])) return true;
    if (rest.length === 3 && rest[0] === '-F' && rest[1] === '=' && prog.test(rest[2])) return true;
    return false;
  }
  if (lead === 'sed') {
    return rest.length === 2 && rest.includes('-n') && rest.some((a) => a === 's/=.*//p');
  }
  return false;
}

function hit(rule) {
  return { rule, reason: REASONS[rule] };
}

const GIT_NAMES_ONLY = new Set([
  '--name-only', '--name-status', '--stat', '--numstat', '--shortstat', '--summary', '-q',
  '--quiet', '--exit-code', '-s', '--check',
]);

// REV:path names a blob; showing it prints the content whatever the flags.
const isRevPath = (a) => /^[^-:\s][^:\s]*:.+$/.test(a);

function gitEnvRule(args) {
  const sub = args.find((a) => ['show', 'diff', 'log', 'blame', 'annotate', 'cat-file', 'grep'].includes(a));
  if (!sub) return null;
  const touches = args.some((a) => {
    const path = a.includes(':') ? a.slice(a.indexOf(':') + 1) : a;
    return isEnvFile(path);
  });
  if (!touches) return null;
  if (sub === 'log') {
    // -L<range>:<file> prints the patch of that range.
    return args.some((a) => ['-p', '--patch', '-u', '-c', '--cc'].includes(a) || /^-L/.test(a))
      ? hit('git-env-file')
      : null;
  }
  if (args.some((a) => GIT_NAMES_ONLY.has(a)) && !args.some(isRevPath)) return null;
  return hit('git-env-file');
}

// ─── segment judgement ──────────────────────────────────────────────────────

// `noUnwrap` is set when the tokens are one suffix of a wrapper's arguments:
// the wrapper already visits every suffix, so a wrapper found there is not
// unwrapped again (keeps the work polynomial however long a chain is).
function checkTokens(tokens, redirIn, depth, noUnwrap) {
  const T = tokens.slice();
  while (T.length && (/^[A-Za-z_]\w*=/.test(T[0]) || SKIP_LEAD.has(T[0]))) T.shift();
  if (!T.length) {
    return redirIn.some(isEnvFile) ? hit('env-file-redirect') : null;
  }
  const lead = baseName(T[0]);
  const args = T.slice(1);
  const touchesEnvFile = () => args.some(isEnvFile) || redirIn.some(isEnvFile);

  if (T.some((t) => /\/proc\/[^/\s]*\/environ/.test(t)) || redirIn.some((t) => /\/proc\/[^/\s]*\/environ/.test(t))) {
    return hit('proc-environ');
  }

  if (lead === 'env') {
    let k = 0;
    while (k < args.length && args[k].startsWith('-') && args[k] !== '-') {
      k += ['-u', '-C', '--unset', '--chdir'].includes(args[k]) ? 2 : 1;
    }
    while (k < args.length && /^[A-Za-z_]\w*=/.test(args[k])) k++;
    const rest = args.slice(k);
    if (!rest.length) return hit('env-print');
    return checkTokens(rest, [], depth, noUnwrap);
  }
  if (lead === 'printenv') {
    // Bulk dump (no operand) is refused. Named operands must all be on the
    // PRINTENV_ALLOWED list; anything else is refused.
    const flags = args.filter((a) => a.startsWith('-'));
    const names = args.filter((a) => !a.startsWith('-'));
    if (!names.length) return hit('printenv');
    if (flags.some((f) => f !== '-0' && f !== '--null')) return hit('printenv-named');
    if (names.some((n) => !PRINTENV_ALLOWED.has(n))) return hit('printenv-named');
    return null;
  }
  if (lead === 'export') {
    if (!args.length || args.every((a) => a === '-p' || a === '--')) return hit('export-print');
    return null;
  }
  if (lead === 'set') {
    return args.length ? null : hit('set-print');
  }
  if (lead === 'declare' || lead === 'typeset') {
    if (!args.length) return hit('declare-print');
    if (args.every((a) => /^-[a-zA-Z]*[px][a-zA-Z]*$/.test(a))) return hit('declare-print');
    return null;
  }
  if (lead === 'echo' || lead === 'printf' || lead === 'print') {
    return args.some(expandsSecretVar) ? hit('secret-expansion') : null;
  }
  if (INTERPRETERS.test(lead)) {
    if (args.some(inlineEnvDump)) return hit('inline-env-dump');
    return null;
  }
  if (lead === 'systemctl') {
    if (args.includes('show-environment')) return hit('systemd-environment');
    if (args.includes('show')) {
      const props = [];
      args.forEach((a, k) => {
        if (a === '-p' || a === '--property') props.push(args[k + 1] || '');
        else if (a.startsWith('--property=')) props.push(a.slice(11));
        else if (/^-p./.test(a)) props.push(a.slice(2));
      });
      if (!props.length || props.some((v) => /Environment/i.test(v))) return hit('systemd-environment');
    }
    return null;
  }
  if (lead === 'git') return gitEnvRule(args);
  if (lead === 'find') {
    const execAt = args.findIndex((a) => ['-exec', '-execdir', '-ok', '-okdir'].includes(a));
    if (execAt === -1) return null;
    const names = args.filter((a, k) => k > 0 && ['-name', '-iname', '-path', '-ipath', '-wholename', '-regex'].includes(args[k - 1]));
    if (!names.some(isEnvFile)) return null;
    const inner = args.slice(execAt + 1);
    const innerLead = baseName(inner[0] || '');
    if (READERS.has(innerLead) || (GREPS.has(innerLead) && !grepIsSafe(innerLead, inner.slice(1)))) {
      return hit('env-file-read');
    }
    return null;
  }

  if (GREPS.has(lead)) {
    const { patterns, files } = grepOperands(lead, args);
    if (redirIn.some(isEnvFile) || files.some(isEnvFile)) {
      if (grepIsSafe(lead, args)) return null;
      // -o with a pattern that can only match identifier characters prints names.
      const onlyNames =
        args.some((a) => a === '--only-matching' || /^-[A-Za-z]*o[A-Za-z]*$/.test(a)) &&
        patterns.length > 0 &&
        patterns.every((pt) => /^\^?\[[A-Za-z0-9_-]+\][*+]$/.test(pt));
      return onlyNames ? null : hit('env-file-grep');
    }
    if (
      isRecursiveGrep(lead, args) &&
      !grepIsSafe(lead, args) &&
      patterns.some((p) => SECRET_NAME.test(p)) &&
      !patterns.some((p) => CODE_REF_PATTERN.test(p)) &&
      !excludesEnvFiles(lead, args) &&
      !includesOnlyNonEnvGlobs(lead, args) &&
      !insideSourceDirs(files)
    ) {
      return hit('env-file-grep-recursive');
    }
    return null;
  }
  if (READERS.has(lead)) {
    if (!touchesEnvFile()) return null;
    if (lead === 'sed' && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) return null;
    if (isNamesOnlyProjection(lead, args)) return null;
    return hit('env-file-read');
  }

  if (CONTAINER_CLIS.has(lead)) {
    if (
      args.includes('config') &&
      (lead === 'docker-compose' || args.includes('compose')) &&
      !args.some((a) => ['--services', '--volumes', '-q', '--quiet', '--images', '--profiles', '--hash'].includes(a))
    ) {
      return hit('compose-config');
    }
    const inspectAt = args.indexOf('inspect');
    if (inspectAt !== -1) {
      if (NON_ENV_INSPECT.has(args[inspectAt - 1])) return null;
      const templates = inspectTemplates(args);
      if (!templates.length) return hit('docker-inspect-no-format');
      if (templates.some(templateLeaks)) return hit('docker-inspect-env');
      return null;
    }
    if (noUnwrap) return null;
    const execAt = args.findIndex((a) => a === 'exec' || a === 'run');
    if (execAt !== -1) return unwrap(args.slice(execAt + 1), depth);
    return null;
  }

  if (WRAPPERS.has(lead)) return noUnwrap ? null : unwrap(args, depth, lead);

  // Any other command reading an env file from stdin.
  if (redirIn.some(isEnvFile)) return hit('env-file-redirect');
  return null;
}

// Judge every suffix of a wrapper's arguments as a command of its own, plus
// every multi-word argument as a nested command string.
function unwrap(args, depth, lead) {
  if (depth > MAX_DEPTH) return hit('too-deep');
  // xargs/parallel append stdin operands after the argv we judge: a printenv
  // beneath them (any flags, any wrapper chain) can print an unjudged name.
  if (
    (OPERAND_APPENDERS.has(lead) || args.some((a) => OPERAND_APPENDERS.has(baseName(a)))) &&
    args.some((a) => /\bprintenv\b/.test(a))
  ) {
    return hit('printenv-named');
  }
  for (let k = 0; k < args.length; k++) {
    const r = checkTokens(args.slice(k), [], depth, true);
    if (r) return r;
  }
  for (const a of args) {
    if (/[\s;|&]/.test(a)) {
      const r = analyze(a, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

function checkSegment(seg, depth) {
  let r = checkTokens(seg.tokens, seg.redirIn, depth, false);
  if (r) return r;
  const lead = baseName(seg.tokens.find((t) => !/^[A-Za-z_]\w*=/.test(t) && !SKIP_LEAD.has(t)) || '');
  const wrapped =
    WRAPPERS.has(lead) ||
    (CONTAINER_CLIS.has(lead) && seg.tokens.some((t) => t === 'exec' || t === 'run'));
  if (wrapped) {
    for (const body of seg.heredocs) {
      r = analyze(body, depth + 1);
      if (r) return r;
    }
  }
  if (INTERPRETERS.test(lead)) {
    if (seg.heredocs.some(inlineEnvDump)) return hit('inline-env-dump');
  }
  return null;
}

function analyze(str, depth) {
  if (typeof str !== 'string' || !str.trim()) return null;
  if (depth > MAX_DEPTH) return hit('too-deep');
  for (const m of str.matchAll(/\$\(([^()]*)\)/g)) {
    const r = analyze(m[1], depth + 1);
    if (r) return r;
  }
  for (const m of str.matchAll(/`([^`]*)`/g)) {
    const r = analyze(m[1], depth + 1);
    if (r) return r;
  }
  const hasSubst = /`|\$\(/.test(str);
  for (const seg of splitSegments(str)) {
    const r = checkSegment(seg, depth);
    if (r) return r;
    // The tokenizer ends a segment at an unquoted backtick or $(, so a
    // substitution among printenv's operands is invisible to its branch.
    if (hasSubst) {
      const l = baseName(seg.tokens.find((t) => !/^[A-Za-z_]\w*=/.test(t) && !SKIP_LEAD.has(t)) || '');
      if (
        l === 'printenv' ||
        ((WRAPPERS.has(l) || l === 'env') && seg.tokens.some((t) => baseName(t) === 'printenv'))
      ) {
        return hit('printenv-named');
      }
    }
  }
  return null;
}

function findEnvValueLeak(command) {
  return analyze(String(command || ''), 0);
}

module.exports = { findEnvValueLeak, isEnvFile, templateLeaks, REASONS, GUIDANCE };
