import {parseRow} from './parser.js';export async function importRows(rows,save){return Promise.all(rows.map(r=>save(parseRow(r))));}
