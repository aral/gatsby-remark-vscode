// @ts-check
const fs = require('fs');
const path = require('path');
const escapeHTML = require('lodash.escape');
const createGetRegistry = require('./createGetRegistry');
const lineHighlighting = require('./lineHighlighting');
const parseCodeFenceHeader = require('./parseCodeFenceHeader');
const { downloadExtensionIfNeeded } = require('./downloadExtension');
const { getClassNameFromMetadata } = require('../lib/vscode/modes');
const { loadColorTheme } = require('../lib/vscode/colorThemeData');
const { generateTokensCSSForColorMap } = require('../lib/vscode/tokenization');
const { getGrammar, getScope, getThemeLocation } = require('./storeUtils');
const styles = fs.readFileSync(path.resolve(__dirname, '../styles.css'), 'utf8');

/**
 * @param {string} missingScopeName 
 * @param {string} rootScopeName
 */
function warnMissingLanguageFile(missingScopeName, rootScopeName) {
  console.warn(`No language file was loaded for scope '${missingScopeName}' (requested by '${rootScopeName}').`);
}

/**
 * @param {string} lang 
 */
function warnUnknownLanguage(lang) {
  console.warn(
    `Encountered unknown language '${lang}'. If '${lang}' is an alias for a supported language, ` +
    `use the 'languageAliases' plugin option to map it to the canonical language name.`);
}

const settingPropertyMap = { 'editor.background': 'background-color', 'editor.foreground': 'color' };
/**
 * @param {Record<string, string>} settings 
 */
function getStylesFromSettings(settings) {
  return Object.keys(settings).reduce((styles, setting) => {
    const property = settingPropertyMap[setting];
    if (property) {
      return [...styles, `${property}: ${settings[setting]};`];
    }
    return styles;
  }, []).join('\n');
}

/**
 * @typedef {object} ExtensionDemand
 * @property {string} identifier
 * @property {string} version
 */

/**
 * @typedef {object} CodeFenceData
 * @property {string} language
 * @property {*} markdownNode
 * @property {*} codeBlockNode
 * @property {*} parsedOptions
 */

/**
 * @typedef {object} LineData
 * @property {string} content The line’s string content 
 * @property {number} index The zero-based line index
 * @property {string} language The code block’s language
 * @property {object} codeBlockOptions The code block’s options parsed from the language suffix
 */

/**
 * @typedef {object} ColorThemeSettings
 * @property {string} defaultTheme
 * @property {string=} prefersLightTheme
 * @property {string=} prefersDarkTheme
 */

/**
 * @typedef {object} PluginOptions
 * @property {string | ((data: CodeFenceData) => string)=} colorTheme
 * @property {string=} prefersLightTheme
 * @property {string=} prefersDarkTheme
 * @property {string=} wrapperClassName
 * @property {Record<string, string>=} languageAliases
 * @property {ExtensionDemand[]=} extensions
 * @property {(line: LineData) => string=} getLineClassName
 * @property {boolean=} injectStyles
 * @property {(colorValue: string, theme: string) => string=} replaceColor
 */

function createPlugin() {
  const getRegistry = createGetRegistry();

  /**
   * 
   * @param {*} _
   * @param {PluginOptions=} options 
   */
  async function textmateHighlight(
    { markdownAST, markdownNode, cache },
    {
      colorTheme = 'Default Dark+',
      prefersLightTheme,
      prefersDarkTheme,
      wrapperClassName = '',
      languageAliases = {},
      extensions = [],
      getLineClassName = () => '',
      injectStyles = true,
      replaceColor = x => x,
    } = {},
  ) {
    /** @type {Record<string, string>} */
    const stylesheets = {};

    for (const node of markdownAST.children) {
      if (node.type !== 'code') continue;
      /** @type {string} */
      const text = node.value || node.children && node.children[0] && node.children[0].value;
      if (!text) continue;
      const { languageName, options } = parseCodeFenceHeader(node.lang ? node.lang.toLowerCase() : '');
      await downloadExtensionIfNeeded('grammar', languageName, extensions, cache);

      const grammarCache = await cache.get('grammars');
      /** @type {string} */
      const scope = getScope(languageName, grammarCache) || getScope(languageAliases[languageName], grammarCache);
      if (!scope && languageName) {
        warnUnknownLanguage(languageName);
      }

      // Set up theme
      const colorThemeValue = typeof colorTheme === 'function'
        ? colorTheme({ markdownNode, codeBlockNode: node, parsedOptions: options, language: languageName })
        : colorTheme;
      await downloadExtensionIfNeeded('theme', colorThemeValue, extensions, cache);

      const themeCache = await cache.get('themes');
      const colorThemePath = getThemeLocation(colorThemeValue, themeCache)
        || path.resolve(markdownNode.fileAbsolutePath, colorThemeValue);

      const { name: themeName, resultRules: tokenColors, resultColors: settings } = loadColorTheme(colorThemePath);
      const defaultTokenColors = {
        settings: {
          foreground: settings['editor.foreground'] || settings.foreground,
          background: settings['editor.background'] || settings.background,
        },
      };

      const [registry, unlockRegistry] = await getRegistry(cache, missingScopeName => {
        warnMissingLanguageFile(missingScopeName, scope)
      });

      registry.setTheme({ settings: [defaultTokenColors, ...tokenColors] });
      if (!stylesheets[themeName]) {
        stylesheets[themeName] = [
          `.${themeName} {\n${getStylesFromSettings(settings)}\n}`,
          ...(scope
            ? generateTokensCSSForColorMap(registry.getColorMap().map(color => replaceColor(color, colorThemeValue)))
            : '').split('\n').map(rule => rule.trim() ? `.${themeName} ${rule}` : ''),
        ].join('\n');
      }

      const rawLines = text.split(/\r?\n/);
      const htmlLines = [];
      /** @type {import('vscode-textmate').ITokenTypeMap} */
      let tokenTypes = {};
      /** @type {number} */
      let languageId;

      try {
        if (scope) {
          const grammarData = getGrammar(scope, grammarCache);
          languageId = grammarData.languageId;
          tokenTypes = grammarData.tokenTypes;
        }

        const highlightedLines = lineHighlighting.parseOptionKeys(options);
        const grammar = languageId && await registry.loadGrammarWithConfiguration(scope, languageId, { tokenTypes });
        let ruleStack = undefined;
        for (let lineIndex = 0; lineIndex < rawLines.length; lineIndex++) {
          const line = rawLines[lineIndex];
          let htmlLine = '';
          if (grammar) {
            const result = grammar.tokenizeLine2(line, ruleStack);
            ruleStack = result.ruleStack;
            for (let i = 0; i < result.tokens.length; i += 2) {
              const startIndex = result.tokens[i];
              const metadata = result.tokens[i + 1];
              const endIndex = result.tokens[i + 2] || line.length;
              /** @type {LineData} */
              htmlLine += [
                `<span class="${getClassNameFromMetadata(metadata)}">`,
                escapeHTML(line.slice(startIndex, endIndex)),
                '</span>',
              ].join('');
            }
          } else {
            htmlLine += escapeHTML(line);
          }
          
          const isHighlighted = highlightedLines.includes(lineIndex + 1);
          const lineData = { codeBlockOptions: options, index: lineIndex, content: line, language: languageName };
          const className = [
            getLineClassName(lineData),
            'vscode-highlight-line',
            isHighlighted ? 'vscode-highlight-line-highlighted' : ''
          ].join(' ').trim();

          htmlLines.push([
            `<span class="${className}">`,
            htmlLine,
            `</span>`
          ].join(''));
        }
      } finally {
        unlockRegistry();
      }

      const className = [wrapperClassName, themeName, 'vscode-highlight'].join(' ').trim();
      node.type = 'html';
      node.value = [
        `<pre class="${className}" data-language="${languageName}">`,
        `<code class="vscode-highlight-code">`,
        htmlLines.join('\n'),
        `</code>`,
        `</pre>`,
      ].join('');
    }

    const themeNames = Object.keys(stylesheets);
    if (themeNames.length) {
      markdownAST.children.push({
        type: 'html',
        value: [
          '<style class="vscode-highlight-styles">',
          injectStyles ? styles : '',
          themeNames.map(theme => stylesheets[theme]).join('\n'),
          '</style>',
        ].join(''),
      });
    }
  };
  return textmateHighlight;
}

module.exports = createPlugin;
