import GLib from "gi://GLib"
import Pango from "gi://Pango"

/**
 * Notification bodies are not trustworthy Pango markup.
 *
 * The freedesktop spec only blesses <b> <i> <u> <a> <img>, but senders ignore
 * that constantly — KDE Connect relays Android notifications verbatim, so we
 * get <br/>, <p>, <span class="...">, HTML entities and unbalanced tags. Pango
 * rejects the whole string on the first thing it does not recognise, and GTK
 * then falls back to painting the raw source, which is why bodies used to read
 * "<b>Husk Hermes</b><br/>I'll dig into this".
 *
 * So instead of feeding the body straight to a markup label, we re-emit it:
 * text runs are decoded and re-escaped, block-level tags become real line
 * breaks, inline tags Pango understands are kept (attributes dropped), and
 * everything else is discarded. Tags are balanced with a stack so the result is
 * always parseable.
 */

/** Inline tags Pango understands and we are happy to pass through. */
const INLINE_TAGS = new Set([
	"b",
	"i",
	"u",
	"s",
	"tt",
	"big",
	"small",
	"sub",
	"sup",
	"span",
])

/** Tags that separate messages/paragraphs and should become a line break. */
const BREAK_TAGS = new Set([
	"br",
	"p",
	"div",
	"li",
	"ul",
	"ol",
	"tr",
	"table",
	"blockquote",
	"pre",
	"hr",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
])

/**
 * The HTML Latin-1 entity names, in codepoint order starting at U+00A0. Listing
 * them this way covers every accented letter a chat client is likely to send
 * without hand-writing a hundred table entries.
 */
const LATIN1_ENTITIES =
	"nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr" +
	" deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest" +
	" Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml" +
	" Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times" +
	" Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig" +
	" agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml" +
	" igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide" +
	" oslash ugrave uacute ucirc uuml yacute thorn yuml"

/** Entity names outside Latin-1 that chat clients reach for constantly. */
const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	hellip: "…",
	mdash: "—",
	ndash: "–",
	lsquo: "‘",
	rsquo: "’",
	ldquo: "“",
	rdquo: "”",
	sbquo: "‚",
	bdquo: "„",
	bull: "•",
	dagger: "†",
	trade: "™",
	euro: "€",
	permil: "‰",
	lsaquo: "‹",
	rsaquo: "›",
	...Object.fromEntries(
		LATIN1_ENTITIES.split(" ").map((name, i) => [name, String.fromCharCode(0xa0 + i)]),
	),
}

/**
 * Turn entity references back into characters. Unknown references are left
 * alone as literal text — they get re-escaped afterwards, so a bare "&" or a
 * made-up "&foo;" survives as-is instead of poisoning the markup.
 */
function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, ref: string) => {
		if (ref.startsWith("#x") || ref.startsWith("#X")) {
			const code = parseInt(ref.slice(2), 16)
			return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match
		}
		if (ref.startsWith("#")) {
			const code = parseInt(ref.slice(1), 10)
			return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match
		}
		// Case matters here: &Eacute; and &eacute; are different letters.
		return NAMED_ENTITIES[ref] ?? match
	})
}

function escape(text: string): string {
	return GLib.markup_escape_text(text, -1)
}

/** Plain text with entities resolved — for labels rendered without markup. */
export function toPlainText(text?: string | null): string {
	if (!text) return ""
	return decodeEntities(text.replace(/<[^>]*>/g, "")).trim()
}

interface ParsedTag {
	name: string
	closing: boolean
	selfClosing: boolean
	attrs: string
}

function parseTag(raw: string): ParsedTag | null {
	const match = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)([^>]*?)(\/?)\s*>$/.exec(raw)
	if (!match) return null
	return {
		closing: match[1] === "/",
		name: match[2].toLowerCase(),
		attrs: match[3] ?? "",
		selfClosing: match[4] === "/",
	}
}

/** Keep only the href/title of an anchor; anything else confuses Pango. */
function anchorAttrs(attrs: string): string {
	let out = ""
	const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g
	let m: RegExpExecArray | null
	while ((m = re.exec(attrs)) !== null) {
		const name = m[1].toLowerCase()
		if (name !== "href" && name !== "title") continue
		const value = decodeEntities(m[3] ?? m[4] ?? "")
		out += ` ${name}="${escape(value)}"`
	}
	return out
}

/**
 * Convert a notification body into markup Pango is guaranteed to accept.
 * Falls back to fully escaped plain text if anything still goes wrong.
 */
export function toPangoMarkup(body?: string | null): string {
	if (!body) return ""

	const out: string[] = []
	const open: string[] = []

	// Split into tags and the text between them.
	const tokens = body.split(/(<[^>]*>)/)

	for (const token of tokens) {
		if (!token) continue

		if (!token.startsWith("<")) {
			out.push(escape(decodeEntities(token)))
			continue
		}

		const tag = parseTag(token)
		if (!tag) {
			// Not actually a tag ("a < b"); treat it as literal text.
			out.push(escape(decodeEntities(token)))
			continue
		}

		if (BREAK_TAGS.has(tag.name)) {
			// A message boundary. <li> also gets a bullet so list-style bodies
			// stay readable.
			out.push("\n")
			if (tag.name === "li" && !tag.closing) out.push("• ")
			continue
		}

		if (tag.name === "img") continue

		if (tag.name === "a") {
			if (tag.closing) {
				if (closeTag(out, open, "a")) continue
				continue
			}
			if (tag.selfClosing) continue
			out.push(`<a${anchorAttrs(tag.attrs)}>`)
			open.push("a")
			continue
		}

		if (!INLINE_TAGS.has(tag.name)) continue

		if (tag.closing) {
			closeTag(out, open, tag.name)
			continue
		}
		if (tag.selfClosing) continue

		// Attributes are dropped: <span class="..."> is invalid Pango, and a
		// bare <span> is a harmless no-op.
		out.push(`<${tag.name}>`)
		open.push(tag.name)
	}

	// Close anything the sender left dangling.
	while (open.length > 0) out.push(`</${open.pop()}>`)

	const markup = collapseBlankLines(out.join(""))

	try {
		// GtkLabel layers <a href> on top of Pango's parser, so Pango alone
		// rejects it. Validate a copy with anchors swapped for a tag Pango does
		// know — everything else about the string is identical.
		const probe = markup.replace(/<a(?:\s[^>]*)?>/g, "<span>").replace(/<\/a>/g, "</span>")
		// A NUL accel marker means "this text has no accelerators".
		Pango.parse_markup(probe, -1, String.fromCharCode(0))
		return markup
	} catch (error) {
		console.warn(`notification markup rejected by pango, showing plain text: ${error}`)
		return escape(collapseBlankLines(stripToText(body)))
	}
}

/**
 * Close `name`, unwinding any tags the sender forgot to close first, so the
 * output stays properly nested. Returns false when there was nothing to close.
 */
function closeTag(out: string[], open: string[], name: string): boolean {
	const index = open.lastIndexOf(name)
	if (index === -1) return false
	while (open.length > index) out.push(`</${open.pop()}>`)
	return true
}

function stripToText(body: string): string {
	return decodeEntities(
		body
			.replace(/<\s*\/?\s*(br|p|div|li|ul|ol|tr|table|blockquote|pre|hr|h[1-6])[^>]*>/gi, "\n")
			.replace(/<[^>]*>/g, ""),
	)
}

/**
 * Trim the edges and never leave a blank line. Nested block tags (a <ul> of
 * <li>s, say) each contribute a break, so without this a three-item list would
 * arrive with a blank line between every entry.
 */
function collapseBlankLines(text: string): string {
	return text
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n[ \t]*\n+/g, "\n")
		.replace(/^\s+|\s+$/g, "")
}
