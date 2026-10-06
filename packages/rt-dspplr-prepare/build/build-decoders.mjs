// Compiles wasm/decoders.c into wasm/decoders.wasm (committed); `npm run build:wasm` then embeds it.
//   FLAC, MP3   dr_flac, dr_mp3 (wasm/third_party, public domain or MIT-0)
//   Ogg Opus    libopus, libogg, opusfile (Xiph.Org, BSD-3-Clause): the release tarballs below,
//               fetched once into wasm/.cache (not in git) and checked against their SHA-256
// Needs zig 0.13 (https://ziglang.org) on PATH, or its path in ZIG, and tar.
//   npm run build:decoders -w packages/rt-dspplr-prepare
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.join(root, 'wasm/.cache');
const zig = process.env.ZIG ?? 'zig';

const SOURCES = [
    { dir: 'opus-1.5.2', url: 'https://downloads.xiph.org/releases/opus/opus-1.5.2.tar.gz', sha256: '65c1d2f78b9f2fb20082c38cbe47c951ad5839345876e46941612ee87f9a7ce1' },
    { dir: 'libogg-1.3.5', url: 'https://downloads.xiph.org/releases/ogg/libogg-1.3.5.tar.gz', sha256: '0eb4b4b9420a0f51db142ba3f9c64b333f826532dc0f48c6410ae51f4799b664' },
    { dir: 'opusfile-0.12', url: 'https://downloads.xiph.org/releases/opus/opusfile-0.12.tar.gz', sha256: '118d8601c12dd6a44f52423e68ca9083cc9f2bfe72da7a8c1acb22a80ae3550b' },
];

fs.mkdirSync(cache, { recursive: true });
for (const s of SOURCES) {
    if (fs.existsSync(path.join(cache, s.dir))) continue;
    const file = path.join(cache, path.basename(s.url));
    if (!fs.existsSync(file)) {
        const response = await fetch(s.url);
        if (!response.ok) throw new Error(`${s.url}: HTTP ${response.status}`);
        fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    }
    const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (sha !== s.sha256) throw new Error(`${file}: SHA-256 ${sha}, expected ${s.sha256}`);
    execFileSync('tar', ['-xzf', path.basename(file)], { cwd: cache, stdio: 'inherit' });
}

// libogg's configure writes ogg/config_types.h; this is what it would say here.
fs.mkdirSync(path.join(cache, 'gen/ogg'), { recursive: true });
fs.writeFileSync(path.join(cache, 'gen/ogg/config_types.h'), `#ifndef __CONFIG_TYPES_H__
#define __CONFIG_TYPES_H__
#include <stdint.h>
typedef int16_t ogg_int16_t;
typedef uint16_t ogg_uint16_t;
typedef int32_t ogg_int32_t;
typedef uint32_t ogg_uint32_t;
typedef int64_t ogg_int64_t;
typedef uint64_t ogg_uint64_t;
#endif
`);

/** A make variable's file list (opus's *_sources.mk). */
function sources(mk, name) {
    const text = fs.readFileSync(path.join(cache, 'opus-1.5.2', mk), 'utf8').replace(/\r/g, '');
    const block = text.split(/\n\s*\n/).find((b) => b.startsWith(`${name} =`));
    if (!block) throw new Error(`${mk}: no ${name}`);
    return block.split(/[\s\\]+/).filter((f) => f.endsWith('.c')).map((f) => path.join(cache, 'opus-1.5.2', f));
}
const opus = [
    ...sources('celt_sources.mk', 'CELT_SOURCES'),
    ...sources('silk_sources.mk', 'SILK_SOURCES'),
    ...sources('silk_sources.mk', 'SILK_SOURCES_FLOAT'),
    ...sources('opus_sources.mk', 'OPUS_SOURCES'),
    ...sources('opus_sources.mk', 'OPUS_SOURCES_FLOAT'),
];
const ogg = ['framing.c', 'bitwise.c'].map((f) => path.join(cache, 'libogg-1.3.5/src', f));
const opusfile = ['opusfile.c', 'info.c', 'internal.c'].map((f) => path.join(cache, 'opusfile-0.12/src', f));

const include = (dir) => ['-I', path.join(cache, dir)];
function compile(out, defines, extra) {
    execFileSync(zig, [
        'cc', '-target', 'wasm32-wasi', '-mexec-model=reactor',
        '-O3', '-msimd128', '-ffp-contract=off', '-s',
        // libopus as its float build, decoder and encoder alike (the linker keeps what is called)
        '-DOPUS_BUILD', '-DVAR_ARRAYS', '-DHAVE_LRINTF', '-DHAVE_LRINT', '-DNDEBUG',
        '-DOP_DISABLE_HTTP', '-DOP_HAVE_LRINTF',
        ...defines.map((d) => `-D${d}`),
        '-I', path.join(root, 'wasm/third_party'),
        ...include('gen'),
        ...include('opus-1.5.2/include'), ...include('opus-1.5.2/celt'), ...include('opus-1.5.2/silk'),
        ...include('opus-1.5.2/silk/float'), ...include('opus-1.5.2'),
        ...include('libogg-1.3.5/include'),
        ...include('opusfile-0.12/include'),
        path.join(root, 'wasm/decoders.c'),
        ...extra,
        '-o', out,
    ], { stdio: 'inherit' });
    return fs.readFileSync(out);
}

// prepare: every codec, whole streams (and runs, for the stems' reads of A).
const full = compile(path.join(root, 'wasm/decoders.wasm'), [], [...opus, ...ogg, ...opusfile]);
console.log(`wasm/decoders.wasm: ${full.length} B`);

// The player: one codec per module, each in a chunk of its own, loaded when a clip of that codec plays.
const player = path.resolve(root, '../rt-dspplr');
const drLicense = 'dr_mp3 and dr_flac by David Reid (https://github.com/mackron/dr_libs): public domain or MIT No Attribution, at the licensee\'s choice.';
const opusLicense = `libopus 1.5.2 (https://opus-codec.org), BSD-3-Clause:\n${fs.readFileSync(path.join(cache, 'opus-1.5.2/COPYING'), 'utf8').replace(/\r/g, '').trim()}`;
const playerModules = [
    { name: 'Mp3', defines: ['RTD_NO_FLAC', 'RTD_NO_OPUS'], extra: [], notice: 'dr_mp3 (David Reid; public domain or MIT-0)', license: drLicense },
    { name: 'Flac', defines: ['RTD_NO_MP3', 'RTD_NO_OPUS'], extra: [], notice: 'dr_flac (David Reid; public domain or MIT-0)', license: drLicense },
    { name: 'Opus', defines: ['RTD_NO_MP3', 'RTD_NO_FLAC', 'RTD_NO_OPUSFILE'], extra: opus, notice: 'libopus (Xiph.Org and contributors; BSD-3-Clause, see THIRD_PARTY_NOTICES.md)', license: opusLicense },
];
const tmp = path.join(cache, 'player');
fs.mkdirSync(tmp, { recursive: true });
for (const m of playerModules) {
    const bytes = compile(path.join(tmp, `decode${m.name}.wasm`), m.defines, m.extra);
    const file = path.join(player, 'src/vendor', `rtdDecode${m.name}.ts`);
    // The notice travels inside the module's data, which no bundler drops (a comment might be).
    fs.writeFileSync(file, `// GENERATED by rt-dspplr-prepare/build/build-decoders.mjs - do not edit.
// The ${m.name.toUpperCase()} decoder of the player's source runs: rt-dspplr-prepare/wasm/decoders.c with
// ${m.notice}, compiled to WebAssembly (SIMD). Loaded in a chunk of its own by RunDecoder.
export default {
    notice: ${JSON.stringify(m.license)},
    wasm: ${JSON.stringify(bytes.toString('base64'))},
};
`);
    console.log(`${path.relative(player, file)}: ${bytes.length} B`);
}
