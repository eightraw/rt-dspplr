#!/usr/bin/env node
// rtd-prepare <input.wav> <outDir> [--segment 10] [--rate 48000|auto|keep] [--peak 256] [--stem <key>=<file>]...
import { main } from '../dist/cli.js';
process.exitCode = await main(process.argv.slice(2));
