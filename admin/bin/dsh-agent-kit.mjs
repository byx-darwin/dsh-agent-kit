#!/usr/bin/env node
import { main } from '../lib/cli/main.js'

process.exitCode = await main(process.argv.slice(2))
