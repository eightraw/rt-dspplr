#!/usr/bin/env node
// rtd-prepare <input> <outDir> [--segment 10] [--peak 256] [--stem <key>=<file>]...
import { main } from '../dist/prepare/cli.js';
process.exitCode = await main(process.argv.slice(2));
