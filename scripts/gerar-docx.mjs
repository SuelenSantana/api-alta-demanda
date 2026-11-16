// Gera DOCUMENTO.docx (Word) a partir do DOCUMENTO.md, sem dependências externas.
// Uso: npm run docx   (ou: node scripts/gerar-docx.mjs [entrada.md] [saida.docx])
//
// Suporta o subconjunto de Markdown usado no DOCUMENTO.md: títulos, parágrafos,
// negrito, itálico, código, links, listas, citações, tabelas e blocos de código.
// Diagramas Mermaid (que o Word não renderiza) viram uma versão em texto.
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateRawSync, crc32 } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entrada = process.argv[2] ?? path.join(raiz, 'DOCUMENTO.md');
const saida = process.argv[3] ?? path.join(raiz, 'DOCUMENTO.docx');

const LARGURA_UTIL = 9638; // A4 (11906 twips) menos margens de 2 cm
const COR_TITULO = '1F3864';
const COR_TABELA = 'D9E2F3';

// ---------- utilidades XML ----------
const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function run(texto, f = {}) {
  if (!texto) return '';
  // A ordem dos elementos segue o esquema do Word (rFonts, b, i, color, sz, u, shd).
  const props = [
    f.code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>' : '',
    f.bold ? '<w:b/>' : '',
    f.italic ? '<w:i/>' : '',
    f.code ? '<w:color w:val="C7254E"/>' : f.link ? '<w:color w:val="2E74B5"/>' : '',
    f.code ? '<w:sz w:val="19"/>' : '',
    f.link ? '<w:u w:val="single"/>' : '',
    f.code ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>' : ''
  ].join('');
  const partes = texto.split('\n');
  return partes.map((p, i) =>
    (i ? '<w:r><w:br/></w:r>' : '') +
    `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(p)}</w:t></w:r>`
  ).join('');
}

// Converte Markdown inline em runs: `código`, **negrito**, *itálico*, [link](url).
function inline(texto, f = {}) {
  const re = /(`[^`]+`)|(\*\*(.+?)\*\*)|(\[([^\]]+)\]\(([^)]+)\))|(\*([^*\s][^*]*?)\*)/;
  let xml = '';
  let resto = texto;
  while (resto) {
    const m = re.exec(resto);
    if (!m) { xml += run(resto, f); break; }
    xml += run(resto.slice(0, m.index), f);
    if (m[1]) xml += run(m[1].slice(1, -1), { ...f, code: true });
    else if (m[2]) xml += inline(m[3], { ...f, bold: true });
    else if (m[4]) xml += inline(m[5], { ...f, link: /^https?:/.test(m[6]) });
    else if (m[7]) xml += inline(m[8], { ...f, italic: true });
    resto = resto.slice(m.index + m[0].length);
  }
  return xml;
}

function par(conteudo, { estilo, ind, keepNext, alinhamento, espacoDepois } = {}) {
  const pPr = [
    estilo ? `<w:pStyle w:val="${estilo}"/>` : '',
    keepNext ? '<w:keepNext/>' : '',
    espacoDepois !== undefined ? `<w:spacing w:after="${espacoDepois}"/>` : '',
    ind ? `<w:ind w:left="${ind.left}" w:hanging="${ind.hanging ?? 0}"/>` : '',
    alinhamento ? `<w:jc w:val="${alinhamento}"/>` : ''
  ].join('');
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${conteudo}</w:p>`;
}

// ---------- tabelas ----------
function dividirLinhaTabela(linha) {
  const celulas = [];
  let atual = '';
  let emCodigo = false;
  const conteudo = linha.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (const c of conteudo) {
    if (c === '`') emCodigo = !emCodigo;
    if (c === '|' && !emCodigo) { celulas.push(atual.trim()); atual = ''; continue; }
    atual += c;
  }
  celulas.push(atual.trim());
  return celulas;
}

function tabela(linhas) {
  const cab = dividirLinhaTabela(linhas[0]);
  const corpo = linhas.slice(2).map(dividirLinhaTabela);
  const n = cab.length;
  // Larguras proporcionais ao conteúdo (com mínimo), somando a largura útil.
  const pesos = Array.from({ length: n }, (_, i) =>
    Math.max(6, Math.min(60, Math.max(...[cab, ...corpo].map(l => (l[i] ?? '').length)))));
  const soma = pesos.reduce((a, b) => a + b, 0);
  const larguras = pesos.map(p => Math.floor(LARGURA_UTIL * p / soma));

  const celula = (texto, i, cabecalho) => {
    const shd = cabecalho ? `<w:shd w:val="clear" w:color="auto" w:fill="${COR_TABELA}"/>` : '';
    return `<w:tc><w:tcPr><w:tcW w:w="${larguras[i]}" w:type="dxa"/>${shd}</w:tcPr>` +
      par(inline(texto ?? '', cabecalho ? { bold: true } : {}), { estilo: 'Tabela' }) + '</w:tc>';
  };
  const linhaXml = (cells, cabecalho) =>
    `<w:tr>${cabecalho ? '<w:trPr><w:tblHeader/><w:cantSplit/></w:trPr>' : '<w:trPr><w:cantSplit/></w:trPr>'}` +
    Array.from({ length: n }, (_, i) => celula(cells[i], i, cabecalho)).join('') + '</w:tr>';

  const borda = (lado) => `<w:${lado} w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/>`;
  return '<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/>' +
    `<w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(borda).join('')}</w:tblBorders>` +
    '<w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:left w:w="90" w:type="dxa"/>' +
    '<w:bottom w:w="40" w:type="dxa"/><w:right w:w="90" w:type="dxa"/></w:tblCellMar></w:tblPr>' +
    `<w:tblGrid>${larguras.map(w => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>` +
    linhaXml(cab, true) + corpo.map(l => linhaXml(l, false)).join('') + '</w:tbl>' +
    par('', { espacoDepois: 60 });
}

// ---------- blocos de código e diagramas ----------
function blocoCodigo(linhas) {
  return par(run(linhas.join('\n'), { code: false }), { estilo: 'Codigo' });
}

function rotuloNo(def) {
  const m = /^\s*(\w+)\s*(?:\[\((.+?)\)\]|\[(.+?)\]|\{(.+?)\}|\((.+?)\))?\s*$/.exec(def);
  if (!m) return { id: def.trim(), rotulo: def.trim() };
  return { id: m[1], rotulo: m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[1] };
}

// Converte os diagramas Mermaid usados no documento em texto equivalente.
function diagrama(linhas) {
  const tipo = linhas[0].trim().split(/\s+/)[0];
  const corpo = linhas.slice(1).map(l => l.trim()).filter(Boolean);
  const itens = [];
  let titulo = 'Diagrama';

  if (tipo === 'flowchart' || tipo === 'graph') {
    titulo = 'Diagrama de fluxo (versão em texto)';
    const nomes = {};
    for (const l of corpo) {
      const m = /^(.+?)\s*-->\s*(?:\|(.+?)\|\s*)?(.+)$/.exec(l);
      if (!m) continue;
      const a = rotuloNo(m[1]); const b = rotuloNo(m[3]);
      for (const no of [a, b]) {
        if (no.rotulo !== no.id) nomes[no.id] = no.rotulo;
        else nomes[no.id] ??= no.id;
      }
      itens.push({ a: a.id, b: b.id, rotulo: m[2] });
    }
    return legenda(titulo) + itens.map((e, i) =>
      item(`${i + 1}.`, `${nomes[e.a]} → ${nomes[e.b]}${e.rotulo ? ` (${e.rotulo})` : ''}`)).join('');
  }

  if (tipo === 'sequenceDiagram') {
    titulo = 'Diagrama de sequência (versão em texto)';
    const nomes = {};
    let passo = 0;
    let nivel = 0;
    for (const l of corpo) {
      let m;
      if ((m = /^participant\s+(\w+)\s+as\s+(.+)$/.exec(l))) { nomes[m[1]] = m[2]; continue; }
      if ((m = /^alt\s+(.+)$/.exec(l))) { itens.push(item('', `Se: ${m[1]}`, 0, true)); nivel = 1; continue; }
      if ((m = /^else\s+(.+)$/.exec(l))) { itens.push(item('', `Senão: ${m[1]}`, 0, true)); nivel = 1; continue; }
      if (l === 'end') { nivel = 0; continue; }
      if ((m = /^(\w+)\s*(-->>|->>|-->|->)\s*(\w+)\s*:\s*(.+)$/.exec(l))) {
        const de = nomes[m[1]] ?? m[1]; const para = nomes[m[3]] ?? m[3];
        const resp = m[2].startsWith('--') ? ' (resposta)' : '';
        const quem = de === para ? de : `${de} → ${para}`;
        itens.push(item(`${++passo}.`, `${quem}${resp}: ${m[4]}`, nivel));
      }
    }
    return legenda(titulo) + itens.join('');
  }

  if (tipo === 'stateDiagram-v2' || tipo === 'stateDiagram') {
    titulo = 'Diagrama de estados (versão em texto)';
    for (const l of corpo) {
      const m = /^(\S+)\s*-->\s*(\S+?)(?:\s*:\s*(.+))?$/.exec(l);
      if (!m) continue;
      const nome = (s, lado) => s === '[*]' ? (lado === 'a' ? 'Início' : 'Fim') : s;
      itens.push(item('•', `${nome(m[1], 'a')} → ${nome(m[2], 'b')}${m[3] ? ` (${m[3]})` : ''}`));
    }
    return legenda(titulo) + itens.join('');
  }

  if (tipo === 'erDiagram') {
    titulo = 'Modelo de dados (versão em texto)';
    let xml = legenda(titulo);
    const card = { '||--o{': 'um para muitos', '||--|{': 'um para um ou mais', '||--||': 'um para um' };
    let entidade = null; let campos = [];
    const fechar = () => {
      if (!entidade) return;
      xml += par(run(entidade, { bold: true }), { keepNext: true, espacoDepois: 40 });
      xml += tabela(['| Campo | Tipo | Chave |', '|---|---|---|',
        ...campos.map(c => `| ${c[1]} | ${c[0]} | ${c[2] ?? ''} |`)]);
      entidade = null; campos = [];
    };
    for (const l of corpo) {
      let m;
      if ((m = /^(\w+)\s+(\S+)\s+(\w+)\s*:\s*(.+)$/.exec(l)) && card[m[2]]) {
        xml += item('•', `${m[1]} ${m[4]} ${m[3]} (${card[m[2]]})`);
      } else if ((m = /^(\w+)\s*\{$/.exec(l))) {
        entidade = m[1];
      } else if (l === '}') {
        fechar();
      } else if (entidade && (m = /^(\w+)\s+(\w+)(?:\s+(\w+))?$/.exec(l))) {
        campos.push([m[1], m[2], m[3]]);
      }
    }
    return xml;
  }

  return blocoCodigo(linhas);
}

const legenda = (texto) => par(run(texto, { bold: true, italic: true }), { estilo: 'Legenda', keepNext: true });
const item = (marcador, texto, nivel = 0, negrito = false) => {
  const left = 360 + nivel * 360;
  return par((marcador ? run(marcador) + '<w:r><w:tab/></w:r>' : '') + inline(texto, negrito ? { bold: true } : {}),
    { estilo: 'Lista', ind: { left: left + 360, hanging: marcador ? 360 : 0 } });
};

// ---------- conversão de blocos ----------
function converter(md) {
  const linhas = md.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let paragrafo = [];
  let i = 0;
  let pularSumario = false;

  const fecharParagrafo = () => {
    if (paragrafo.length) out.push(par(inline(paragrafo.join('\n'))));
    paragrafo = [];
  };

  while (i < linhas.length) {
    const linha = linhas[i];

    if (pularSumario) {
      if (/^##\s/.test(linha) || /^---\s*$/.test(linha)) { pularSumario = false; } else { i++; continue; }
    }

    const fence = /^```(\w*)/.exec(linha);
    if (fence) {
      fecharParagrafo();
      const bloco = [];
      i++;
      while (i < linhas.length && !/^```/.test(linhas[i])) bloco.push(linhas[i++]);
      i++;
      out.push(fence[1] === 'mermaid' ? diagrama(bloco) : blocoCodigo(bloco));
      continue;
    }

    const titulo = /^(#{1,4})\s+(.*)$/.exec(linha);
    if (titulo) {
      fecharParagrafo();
      const nivel = titulo[1].length;
      const texto = titulo[2];
      if (nivel === 1) {
        out.push(par(inline(texto), { estilo: 'Title' }));
        out.push(par(run('Material de estudo — gerado a partir do DOCUMENTO.md'), { estilo: 'Subtitle' }));
      } else if (nivel === 2 && /^Sum[aá]rio$/i.test(texto.trim())) {
        out.push(par(run('Sumário'), { estilo: 'TOCHeading' }));
        out.push('<w:p><w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r>' +
          '<w:r><w:instrText xml:space="preserve"> TOC \\o "1-2" \\h \\z \\u </w:instrText></w:r>' +
          '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
          run('Clique com o botão direito aqui e escolha "Atualizar campo" para montar o sumário.', { italic: true }) +
          '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>');
        pularSumario = true;
      } else {
        out.push(par(inline(texto), { estilo: `Heading${nivel - 1}` }));
      }
      i++;
      continue;
    }

    if (/^---\s*$/.test(linha)) { fecharParagrafo(); i++; continue; }

    if (/^\s*\|/.test(linha)) {
      fecharParagrafo();
      const bloco = [];
      while (i < linhas.length && /^\s*\|/.test(linhas[i])) bloco.push(linhas[i++]);
      out.push(tabela(bloco));
      continue;
    }

    if (/^>\s?/.test(linha)) {
      fecharParagrafo();
      const bloco = [];
      while (i < linhas.length && /^>\s?/.test(linhas[i])) bloco.push(linhas[i++].replace(/^>\s?/, ''));
      out.push(par(inline(bloco.join('\n')), { estilo: 'Citacao' }));
      continue;
    }

    const lista = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(linha);
    if (lista) {
      fecharParagrafo();
      const nivel = lista[1].length >= 2 ? 1 : 0;
      let marcador = /\d/.test(lista[2]) ? lista[2] : (nivel ? '◦' : '•');
      let texto = lista[3];
      const caixa = /^\[( |x)\]\s+(.*)$/i.exec(texto);
      if (caixa) { marcador = caixa[1] === ' ' ? '☐' : '☑'; texto = caixa[2]; }
      // Linhas seguintes recuadas (sem marcador) continuam o mesmo item.
      i++;
      while (i < linhas.length && /^\s{2,}\S/.test(linhas[i]) && !/^\s*([-*]|\d+\.)\s/.test(linhas[i])) {
        texto += '\n' + linhas[i++].trim();
      }
      out.push(item(marcador, texto, nivel));
      continue;
    }

    if (!linha.trim()) { fecharParagrafo(); i++; continue; }

    paragrafo.push(linha.trim());
    i++;
  }
  fecharParagrafo();
  return out.join('\n');
}

// ---------- partes do pacote .docx ----------
const ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function documento(corpo) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${ns}><w:body>${corpo}
<w:sectPr><w:footerReference w:type="default" r:id="rId3"/>
<w:pgSz w:w="11906" w:h="16838"/>
<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/>
</w:sectPr></w:body></w:document>`;
}

const estilo = (id, nome, pPr = '', rPr = '', extra = '') =>
  `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${nome}"/><w:basedOn w:val="Normal"/>` +
  `<w:next w:val="Normal"/><w:qFormat/>${extra}<w:pPr>${pPr}</w:pPr><w:rPr>${rPr}</w:rPr></w:style>`;

const estilos = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${ns}>
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/>
<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="pt-BR"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
${estilo('Title', 'Title', '<w:spacing w:before="2400" w:after="200"/><w:jc w:val="center"/>',
  `<w:b/><w:color w:val="${COR_TITULO}"/><w:sz w:val="52"/>`)}
${estilo('Subtitle', 'Subtitle', '<w:spacing w:after="1200"/><w:jc w:val="center"/>',
  '<w:i/><w:color w:val="595959"/><w:sz w:val="26"/>')}
${estilo('TOCHeading', 'TOC Heading', '<w:pageBreakBefore/><w:spacing w:after="240"/>',
  `<w:b/><w:color w:val="${COR_TITULO}"/><w:sz w:val="32"/>`)}
${estilo('Heading1', 'heading 1',
  `<w:keepNext/><w:pageBreakBefore/><w:pBdr><w:bottom w:val="single" w:sz="8" w:space="4" w:color="${COR_TITULO}"/></w:pBdr><w:spacing w:after="200"/><w:outlineLvl w:val="0"/>`,
  `<w:b/><w:color w:val="${COR_TITULO}"/><w:sz w:val="34"/>`)}
${estilo('Heading2', 'heading 2', '<w:keepNext/><w:spacing w:before="280" w:after="120"/><w:outlineLvl w:val="1"/>',
  '<w:b/><w:color w:val="2E74B5"/><w:sz w:val="27"/>')}
${estilo('Heading3', 'heading 3', '<w:keepNext/><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="2"/>',
  '<w:b/><w:color w:val="404040"/><w:sz w:val="23"/>')}
${estilo('Tabela', 'Texto de tabela', '<w:spacing w:after="0" w:line="240" w:lineRule="auto"/>', '<w:sz w:val="19"/>')}
${estilo('Lista', 'Item de lista', '<w:spacing w:after="60"/>')}
${estilo('Legenda', 'Legenda de diagrama', '<w:spacing w:before="120" w:after="60"/>', '<w:color w:val="2E74B5"/>')}
${estilo('Codigo', 'Bloco de codigo',
  '<w:pBdr><w:top w:val="single" w:sz="4" w:space="4" w:color="D9D9D9"/><w:left w:val="single" w:sz="4" w:space="4" w:color="D9D9D9"/>' +
  '<w:bottom w:val="single" w:sz="4" w:space="4" w:color="D9D9D9"/><w:right w:val="single" w:sz="4" w:space="4" w:color="D9D9D9"/></w:pBdr>' +
  '<w:shd w:val="clear" w:color="auto" w:fill="F5F5F5"/><w:spacing w:after="160" w:line="240" w:lineRule="auto"/>' +
  '<w:ind w:left="113" w:right="113"/>',
  '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="17"/>')}
${estilo('Citacao', 'Citacao destacada',
  '<w:pBdr><w:left w:val="single" w:sz="24" w:space="8" w:color="2E74B5"/></w:pBdr>' +
  '<w:shd w:val="clear" w:color="auto" w:fill="EEF3FA"/><w:spacing w:before="120" w:after="160"/><w:ind w:left="284" w:right="113"/>',
  '<w:i/><w:color w:val="1F3864"/>')}
${estilo('TOC1', 'toc 1', '<w:tabs><w:tab w:val="right" w:leader="dot" w:pos="9628"/></w:tabs><w:spacing w:before="80" w:after="40"/>', '<w:b/>')}
${estilo('TOC2', 'toc 2', '<w:tabs><w:tab w:val="right" w:leader="dot" w:pos="9628"/></w:tabs><w:spacing w:after="20"/><w:ind w:left="284"/>', '<w:sz w:val="20"/>')}
<w:style w:type="paragraph" w:styleId="Rodape"><w:name w:val="footer"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:color w:val="7F7F7F"/><w:sz w:val="18"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="2E74B5"/><w:u w:val="single"/></w:rPr></w:style>
</w:styles>`;

const rodape = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr ${ns}><w:p><w:pPr><w:pStyle w:val="Rodape"/></w:pPr>
<w:r><w:t xml:space="preserve">API sob Alta Demanda — página </w:t></w:r>
<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>
<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>
</w:p></w:ftr>`;

const configuracoes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings ${ns}><w:defaultTabStop w:val="709"/>
<w:characterSpacingControl w:val="doNotCompress"/><w:updateFields w:val="true"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;

const tiposConteudo = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;

const relsPacote = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;

const relsDocumento = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
</Relationships>`;

const propriedades = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>API sob Alta Demanda — Documento do Projeto</dc:title><dc:language>pt-BR</dc:language>
<dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</dcterms:created>
</cp:coreProperties>`;

// ---------- ZIP mínimo (deflate) ----------
function zip(arquivos) {
  const locais = [];
  const central = [];
  let deslocamento = 0;
  for (const [nome, conteudo] of arquivos) {
    const dados = Buffer.from(conteudo, 'utf8');
    const comprimido = deflateRawSync(dados);
    const nomeBuf = Buffer.from(nome, 'utf8');
    const crc = crc32(dados);
    const cab = Buffer.alloc(30);
    cab.writeUInt32LE(0x04034b50, 0); cab.writeUInt16LE(20, 4); cab.writeUInt16LE(0x0800, 6);
    cab.writeUInt16LE(8, 8); cab.writeUInt16LE(0, 10); cab.writeUInt16LE(0x21, 12);
    cab.writeUInt32LE(crc, 14); cab.writeUInt32LE(comprimido.length, 18); cab.writeUInt32LE(dados.length, 22);
    cab.writeUInt16LE(nomeBuf.length, 26); cab.writeUInt16LE(0, 28);
    locais.push(cab, nomeBuf, comprimido);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8); dir.writeUInt16LE(8, 10); dir.writeUInt16LE(0, 12); dir.writeUInt16LE(0x21, 14);
    dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(comprimido.length, 20); dir.writeUInt32LE(dados.length, 24);
    dir.writeUInt16LE(nomeBuf.length, 28); dir.writeUInt32LE(deslocamento, 42);
    central.push(dir, nomeBuf);
    deslocamento += 30 + nomeBuf.length + comprimido.length;
  }
  const tamanhoCentral = central.reduce((s, b) => s + b.length, 0);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0); fim.writeUInt16LE(arquivos.length, 8); fim.writeUInt16LE(arquivos.length, 10);
  fim.writeUInt32LE(tamanhoCentral, 12); fim.writeUInt32LE(deslocamento, 16);
  return Buffer.concat([...locais, ...central, fim]);
}

const md = readFileSync(entrada, 'utf8');
writeFileSync(saida, zip([
  ['[Content_Types].xml', tiposConteudo],
  ['_rels/.rels', relsPacote],
  ['docProps/core.xml', propriedades],
  ['word/document.xml', documento(converter(md))],
  ['word/_rels/document.xml.rels', relsDocumento],
  ['word/styles.xml', estilos],
  ['word/settings.xml', configuracoes],
  ['word/footer1.xml', rodape]
]));
console.log(`Gerado: ${path.relative(process.cwd(), saida) || saida}`);
