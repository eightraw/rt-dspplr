#!/usr/bin/env node
// rtd-prepare <input.wav> <outDir> [--segment 10] [--rate 48000|auto|keep] [--peak 256]
import { main } from '../dist/prepare-cli.js';
process.exitCode = await main(process.argv.slice(2));
