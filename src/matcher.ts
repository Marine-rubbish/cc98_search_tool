import { decodeHTML } from 'entities';
import { marked } from 'marked';
import { Parser } from 'htmlparser2';

/*
 * 将纯文本、UBB 或 Markdown 转为用于匹配的可见文字。
 * 保留引用和代码文字，去掉支持的格式标签与媒体内容，最后统一换行和 Unicode。
 */
export function visibleText(source: string, format: 'plain' | 'ubb' | 'markdown' = 'ubb'): string {
  let text = source;
  if (format === 'markdown') {
    text = '';
    let hidden = 0;
    const parser = new Parser({
      /* 跳过脚本和样式内容；可见区域的 br 保留为换行。 */
      onopentag(name) {
        if (['script', 'style'].includes(name)) hidden++;
        if (name === 'br' && !hidden) text += '\n';
      },
      /* 仅收集可见文本节点，链接地址等 HTML 属性不会进入搜索文本。 */
      ontext(value) { if (!hidden) text += value; },
      /* 离开隐藏区域后恢复收集，并在段落等块级元素末尾保留换行。 */
      onclosetag(name) {
        if (['script', 'style'].includes(name)) hidden = Math.max(0, hidden - 1);
        if (!hidden && /^(p|div|li|tr|h[1-6]|pre|blockquote)$/.test(name)) text += '\n';
      },
    }, { decodeEntities: true });
    parser.end(marked.parse(source, { async: false }));
  } else if (format === 'ubb') {
    /* 媒体连同内部地址一起删除；文字格式标签仅去掉外层，保留其中正文。 */
    text = decodeHTML(source
      .replace(/\[(img|upload|audio|video|flash)(?:=[^\]]*)?\][\s\S]*?\[\/\1\]/gi, '')
      .replace(/\[\/?(?:b|i|u|s|color|size|font|quote|quotex|center|left|right|align|url|email|code|list|li|table|tr|td|p)(?:[=\s][^\]]*)?\]/gi, ''));
  }
  return text.replace(/\r\n/g, '\n').normalize('NFC');
}

/*
 * 在可见文字中做字面包含匹配，默认忽略英文大小写。
 * 命中时返回前 70、后 100 个字符左右的上下文片段，未命中返回 undefined。
 */
export function matchText(source: string, keyword: string, caseSensitive = false, format: 'plain' | 'ubb' | 'markdown' = 'ubb'): string | undefined {
  const content = visibleText(source, format);
  /* 正文和关键词都规范化，避免同一字符的不同 Unicode 表示影响匹配。 */
  const query = keyword.normalize('NFC');
  const index = (caseSensitive ? content : content.toLowerCase()).indexOf(caseSensitive ? query : query.toLowerCase());
  if (index < 0) return;
  return `${index > 70 ? '…' : ''}${content.slice(Math.max(0, index - 70), index + query.length + 100)}${index + query.length + 100 < content.length ? '…' : ''}`;
}
