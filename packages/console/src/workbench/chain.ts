/**
 * 把没有根的卡推断成链路。
 *
 * 为什么需要它：`rootId` 是**新写入**才带的东西。存量卡片（以及不传根的调用方）
 * 各自成链，同一件事在板上就是好几张——用户看到的正是这个。
 *
 * 规则刻意保守，三条一起才并：
 *
 * 1. **只在无根的卡之间**推断，已经成链的不动（有根说明有人明确说过它属于谁）。
 * 2. **共享至少两个标题 token**，或共享一个**强标识符**（≥6 字符且含数字，
 *    例如 `EXEPD-229676`）。单靠 `jira`、`DSH` 这种弱词合不起来。
 * 3. **时间窗 2 小时**内，且一条链最多 8 张。
 *
 * 推断出来的链会标 `inferred`，界面上说明「这是推断的」，并给「拆开」——误合并
 * 必须能撤销，否则宁可不要自动合并。
 *
 * @module @free-dsh-console/workbench/chain
 */

/** 一条推断出来的链。 */
export interface InferredChain {
  /** 根卡 id：簇里最早的那张。 */
  readonly rootId: string
  /** 归到它名下的其它卡（不含根自己）。 */
  readonly cardIds: readonly string[]
}

/** 两张卡相差多久之内才算同一次。 */
export const CHAIN_WINDOW_MS = 2 * 60 * 60 * 1000

/** 一条链最多并几张：再多就不是「同一件事」了。 */
export const CHAIN_MAX_STEPS = 8

/** 标题里不构成「同一件事」证据的词：来源名、通用动词。 */
const WEAK_TOKENS: ReadonlySet<string> = new Set([
  '邮件', '手动', '派单', '子会话', '会话', '通知', 'jira', 'mail', 'none', 'null',
  'the', 'and', 'for', 'with',
])

/** 开头那层来源标记：`[邮件] …`。 */
const LEADING_MARK = /^\s*\[[^\]]*\]\s*/u

/** 日期与时刻：`2026-10-30 15:50`、`10-30`、`15:50`。 */
const STAMPS = /\d{4}-\d{1,2}-\d{1,2}|\d{1,2}:\d{2}/gu

/** 拉丁词（连字符保留，`EXEPD-229676` 是一个 token）与中文段。 */
const TOKEN = /[a-z0-9][a-z0-9-]*|[\u4e00-\u9fa5]{2,}/gu

/**
 * 标题切成比较用的 token。
 *
 * 去掉来源标记、日期时刻，小写；中文按连续段切，拉丁词按连字符保留成一个整体
 * ——工单号正是这样才认得出来。
 * @param title - 卡片标题。
 * @returns 去重后的 token；没有任何实质 token 时是空集合。
 */
export function titleTokens(title: string): ReadonlySet<string> {
  const body = title.replace(LEADING_MARK, '').replace(STAMPS, ' ').toLowerCase()
  const tokens = new Set<string>()
  for (const match of body.matchAll(TOKEN)) {
    const token = match[0].replace(/-+$/, '')
    if (token.length < 2 || WEAK_TOKENS.has(token)) continue
    tokens.add(token)
  }
  return tokens
}

/**
 * 一个 token 是否强到「单独出现就够」。
 *
 * 工单号、邮件 id 这类带数字的长词不会被两封不同的邮件共用；`dsh`、`e2e` 会。
 * @param token - 一个标题 token。
 * @returns 是否是强标识符。
 */
export function isStrongToken(token: string): boolean {
  return token.length >= 6 && /\d/u.test(token)
}

/**
 * 两组 token 是否够格算同一件事。
 *
 * @param left - 第一张卡的 token。
 * @param right - 第二张卡的 token。
 * @returns 共享强标识符，或共享至少两个 token。
 */
export function sharesChainTokens(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  let shared = 0
  for (const token of left) {
    if (!right.has(token)) continue
    if (isStrongToken(token)) return true
    shared += 1
    if (shared >= 2) return true
  }
  return false
}

/** 推断只需要卡上的这几个字段。 */
export interface ChainCandidate {
  readonly id: string
  readonly title: string
  readonly createdAt: number
  /** 已经有根（不等于自己）的卡不参与推断。 */
  readonly rootId?: string
}

/**
 * 把无根的卡按标题与时间聚成链。
 *
 * O(n²)，但候选只有「自成一链」的卡，板子上通常几十张——真到几千张再谈索引，
 * 那之前先让它简单。
 * @param cards - 板上全部卡片。
 * @returns 每条推断出来的链（只有真并了才出现），根是簇里最早的那张。
 */
export function inferChains(cards: readonly ChainCandidate[]): readonly InferredChain[] {
  const loose = cards
    .filter(card => card.rootId === undefined || card.rootId === card.id)
    .map(card => ({ card, tokens: titleTokens(card.title) }))
    .sort((left, right) => left.card.createdAt - right.card.createdAt)
  const taken = new Set<string>()
  const chains: InferredChain[] = []
  for (const seed of loose) {
    if (taken.has(seed.card.id) || seed.tokens.size === 0) continue
    const members = [seed]
    for (const other of loose) {
      if (other.card.id === seed.card.id || taken.has(other.card.id)) continue
      if (members.length >= CHAIN_MAX_STEPS) break
      // 与簇内任一成员同族就入簇：链式聚类，`A≈B`、`B≈C` 时三张是一件事。
      // 时间用绝对差：只比「比 seed 晚多少」会让更早的那张反过来并进更晚的。
      if (Math.abs(other.card.createdAt - seed.card.createdAt) > CHAIN_WINDOW_MS) continue
      if (other.tokens.size === 0) continue
      if (!members.some(member => sharesChainTokens(member.tokens, other.tokens))) continue
      members.push(other)
    }
    if (members.length < 2) continue
    for (const member of members) taken.add(member.card.id)
    chains.push({
      rootId: seed.card.id,
      cardIds: members.slice(1).map(member => member.card.id),
    })
  }
  return chains
}
