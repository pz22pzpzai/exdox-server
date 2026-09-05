type EmailAction = {
  label: string;
  url: string;
};

type EmailLink = {
  label: string;
  url: string;
};

export function buildExdoxEmailHtml(input: {
  heading: string;
  greeting?: string;
  paragraphs: string[];
  details?: string[];
  action?: EmailAction;
  links?: EmailLink[];
}) {
  const paragraphs = input.paragraphs
    .map((paragraph) => `<p style="font-size:16px;line-height:1.6;margin:0 0 16px">${linkifyEmailText(paragraph)}</p>`)
    .join('');
  const details = input.details?.length
    ? `<div style="background:#f3f7fa;border-radius:10px;margin:8px 0 20px;padding:16px">${input.details
        .map((detail) => `<div style="font-size:15px;line-height:1.6">${linkifyEmailText(detail)}</div>`)
        .join('')}</div>`
    : '';
  const action = input.action
    ? `<div style="margin:24px 0"><a href="${safeEmailUrl(input.action.url)}" style="display:inline-block;background:#10203d;color:#ffffff;text-decoration:none;font-weight:700;padding:14px 22px;border-radius:8px">${escapeEmailHtml(input.action.label)}</a></div>
       <p style="font-size:13px;line-height:1.6;color:#65758c;margin:0 0 18px">If the button does not work, use this full link:<br><a href="${safeEmailUrl(input.action.url)}" style="color:#087fc1;word-break:break-all">${escapeEmailHtml(input.action.url)}</a></p>`
    : '';
  const links = input.links?.length
    ? `<div style="margin-top:20px">${input.links
        .map((link) => `<p style="font-size:14px;line-height:1.6;margin:6px 0"><a href="${safeEmailUrl(link.url)}" style="color:#087fc1;word-break:break-all">${escapeEmailHtml(link.label)}</a></p>`)
        .join('')}</div>`
    : '';

  return `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#eef4f8;font-family:Arial,sans-serif;color:#10203d">
    <div style="max-width:600px;margin:0 auto;padding:32px 20px">
      <div style="background:#ffffff;border:1px solid #d3dfeb;border-radius:16px;padding:32px">
        <div style="font-size:26px;font-weight:700;margin-bottom:24px">Exdox</div>
        <h1 style="font-size:24px;line-height:1.3;margin:0 0 18px">${escapeEmailHtml(input.heading)}</h1>
        ${input.greeting ? `<p style="font-size:16px;line-height:1.6;margin:0 0 16px">${escapeEmailHtml(input.greeting)}</p>` : ''}
        ${paragraphs}
        ${details}
        ${action}
        ${links}
        <p style="font-size:13px;line-height:1.6;color:#65758c;margin:24px 0 0">Exdox support<br><a href="mailto:contact@exdox.co.uk" style="color:#087fc1">contact@exdox.co.uk</a></p>
      </div>
    </div>
  </body>
</html>`;
}

export function escapeEmailHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function linkifyEmailText(value: string) {
  const urlPattern = /https?:\/\/[^\s<]+/gi;
  let cursor = 0;
  let html = '';
  for (const match of value.matchAll(urlPattern)) {
    const index = match.index ?? 0;
    const url = trimTrailingUrlPunctuation(match[0]);
    const trailing = match[0].slice(url.length);
    html += escapeEmailHtml(value.slice(cursor, index)).replaceAll('\n', '<br>');
    html += `<a href="${safeEmailUrl(url)}" style="color:#087fc1;word-break:break-all">${escapeEmailHtml(url)}</a>`;
    html += escapeEmailHtml(trailing);
    cursor = index + match[0].length;
  }
  html += escapeEmailHtml(value.slice(cursor)).replaceAll('\n', '<br>');
  return html;
}

function trimTrailingUrlPunctuation(value: string) {
  return value.replace(/[.,!?;:]+$/, '');
}

function safeEmailUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
      ? escapeEmailHtml(parsed.toString())
      : '#';
  } catch {
    return '#';
  }
}
