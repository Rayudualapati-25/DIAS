package org.dias.mobile.presentation

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import org.dias.mobile.domain.AccessLog
import org.dias.mobile.domain.AccessLogRow
import org.dias.mobile.domain.LogCell
import org.dias.mobile.domain.LogPage
import org.dias.mobile.domain.Session
import org.dias.mobile.domain.countedLog
import org.dias.mobile.domain.isCutOff
import org.dias.mobile.domain.logPage
import java.text.DateFormat
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Date

/** What the screen's message line says after a read. */
internal fun AccessLog.readMessage(): String = "Access log read from Fabric: " + if (full) {
    "${countedLog(entries.size, "request", "requests")}."
} else {
    "${countedLog(entries.size, "decision", "decisions")} on the channel and " +
        "${mine.size} of your own requests."
}

/**
 * The access log card: for every request on the channel, who requested which case file, what the LLM
 * recommended, and what the auditor decided. The Activity reads the log; this card shows what was read.
 */
internal class AccessLogPanel(private val context: Context, parent: LinearLayout) {
    private enum class Tab { EVERYONE, MINE }
    private data class Shown(val log: AccessLog? = null, val tab: Tab = Tab.EVERYONE, val offset: Int = 0)

    private var shown = Shown()
    private val card = context.card(parent)
    private val info: TextView
    private val scope: TextView
    /** Where the Activity puts its Refresh button, so that it follows the screen's busy state. */
    val controls = bar()
    private val tabs = bar()
    private val everyone = localButton(tabs, "access_log_all") { show(shown.copy(tab = Tab.EVERYONE, offset = 0)) }
    private val mine = localButton(tabs, "access_log_mine") { show(shown.copy(tab = Tab.MINE, offset = 0)) }
    private val rows = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL; tag = "access_log_rows" }
    private val pager = bar()
    private val newer = localButton(pager, "access_log_newer", "Newer") { show(shown.copy(offset = shown.offset - PAGE)) }
    private val older = localButton(pager, "access_log_older", "Older") { show(shown.copy(offset = shown.offset + PAGE)) }
    private val position = context.label("", 12).apply { tag = "access_log_position" }
    private val cutOff = context.label(CUT_OFF_NOTE, 12).apply { tag = "access_log_cut_off" }

    init {
        card.addView(context.label("Access log", 22, true))
        card.addView(context.label("Who requested which case file, what the LLM recommended, and what " +
            "the auditor decided. Read from the Fabric ledger.", 13))
        info = context.label("", 13).apply { tag = "access_log_info" }.also { card.addView(it) }
        card.addView(controls)
        scope = context.label("", 12).apply { tag = "access_log_scope" }.also { card.addView(it) }
        card.addView(tabs)
        card.addView(rows)
        card.addView(position)
        card.addView(pager)
        card.addView(cutOff)
    }

    /** Show `log` as read for `session`. A new read starts again at the newest entry. */
    fun render(session: Session?, log: AccessLog?, readAt: Long?) {
        info.text = when {
            session == null -> "Sign in to read the access log."
            log == null -> "Press Refresh to read the access log from Fabric."
            else -> listOfNotNull(
                countedLog(log.entries.size, if (log.full) "request" else "decision",
                    if (log.full) "requests" else "decisions").replaceFirstChar { it.uppercase() } +
                    " on the ledger",
                if (log.full) null else "${log.mine.size} of your own",
                readAt?.let { "read ${DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(it))}" },
            ).joinToString(" · ")
        }
        show(when {
            log === shown.log -> shown
            // A new read of a reduced log keeps the list the reader was on.
            log != null && !log.full -> Shown(log, shown.tab)
            else -> Shown(log)
        })
    }

    private fun show(next: Shown) {
        val log = next.log
        val list = when {
            log == null -> emptyList()
            next.tab == Tab.MINE -> log.mine
            else -> log.entries
        }
        val page = list.logPage(next.offset, PAGE)
        shown = next.copy(offset = page.offset)

        scope.visibility = if (log == null) View.GONE else View.VISIBLE
        scope.text = if (log?.full == true) FULL_NOTE else REDUCED_NOTE
        tabs.visibility = if (log == null || log.full) View.GONE else View.VISIBLE
        everyone.text = tabLabel("All decisions", log?.entries)
        mine.text = tabLabel("My requests", log?.mine)
        mark(everyone, next.tab == Tab.EVERYONE)
        mark(mine, next.tab == Tab.MINE)

        rows.removeAllViews()
        if (log != null && list.isEmpty()) rows.addView(context.label(emptyNote(log, next.tab), 13))
        page.rows.forEach { row ->
            rows.addView(rowView(row))
            context.divider(rows)
        }
        val paged = page.total > PAGE
        pager.visibility = if (paged) View.VISIBLE else View.GONE
        position.visibility = if (page.total > 0) View.VISIBLE else View.GONE
        position.text = positionLabel(page)
        cutOff.visibility = if (list.isCutOff()) View.VISIBLE else View.GONE
        newer.isEnabled = page.hasNewer
        older.isEnabled = page.hasOlder
    }

    private fun tabLabel(name: String, list: List<*>?): String = "$name (${list?.size ?: 0})"

    /** The list that is shown has its name in bold and in the accent colour. */
    private fun mark(tab: Button, selected: Boolean) {
        tab.isSelected = selected
        tab.setTypeface(null, if (selected) Typeface.BOLD else Typeface.NORMAL)
        tab.setTextColor(if (selected) GRANTED else INK)
    }

    private fun positionLabel(page: LogPage): String =
        "${page.offset + 1}–${page.offset + page.rows.size} of ${page.total}"

    private fun emptyNote(log: AccessLog, tab: Tab): String = when {
        tab == Tab.MINE -> "You have not made an access request."
        log.full -> "No access request has been recorded on this channel."
        else -> "No request has been decided yet on this channel."
    }

    private fun rowView(row: AccessLogRow): View = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL; setPadding(0, context.dp(10), 0, context.dp(10))
        addView(context.label(listOfNotNull(localTime(row.time), row.requestId).joinToString(" · "), 12))
        addView(context.label(line(row.who), 15, true))
        addView(context.label(line(row.what), 13))
        addView(context.label("LLM recommended: ${line(row.llm)}", 13))
        addView(context.label("Auditor decided: ${line(row.decision)}", 13))
        addView(context.label("Outcome: ${line(row.outcome)}", 13, true).apply {
            OUTCOME_COLORS[row.outcome.label]?.let { setTextColor(it) }
        })
    }

    private fun line(cell: LogCell): String = listOfNotNull(cell.label, cell.detail).joinToString(" · ")

    private fun bar() = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL }

    /** A button that only changes what this card shows; it reads nothing from the host. */
    private fun localButton(parent: LinearLayout, tag: String, text: String = "", action: () -> Unit) =
        Button(context).apply {
            this.tag = tag; this.text = text; isAllCaps = false
            setOnClickListener { action() }
        }.also { parent.addView(it) }

    private companion object {
        const val PAGE = org.dias.mobile.domain.ACCESS_LOG_PAGE
        const val FULL_NOTE = "Full log: every request on the channel with names and case files, " +
            "including requests still waiting for an auditor. Until the auditor decides, the LLM's " +
            "advice on a request is shown to reviewers only."
        const val REDUCED_NOTE = "Reduced log: this host shares every decision and the LLM recommendation " +
            "it was taken against, without names or case files. Your own requests are shown in full " +
            "under My requests."
        const val CUT_OFF_NOTE = "Only the newest " + org.dias.mobile.domain.ACCESS_LOG_LIMIT +
            " are loaded. Older requests stay on the ledger and are not shown here."
        val GRANTED = Color.parseColor("#176B65")
        val OUTCOME_COLORS = mapOf("GRANTED" to GRANTED, "DENIED" to Color.parseColor("#A33A2B"))
        private val TIME = DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT)

        /** The ledger's UTC timestamp in the phone's own time zone. */
        fun localTime(utc: String?): String = if (utc == null) "Time not recorded" else try {
            Instant.parse(utc).atZone(ZoneId.systemDefault()).format(TIME)
        } catch (_: Exception) { utc }
    }
}
