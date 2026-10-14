package org.dias.mobile.presentation

import android.content.Context
import android.text.InputFilter
import android.text.InputType
import android.view.View
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Spinner
import org.dias.mobile.domain.AccessRequestDraft
import org.dias.mobile.domain.AccessRequestStatus
import org.dias.mobile.domain.JUSTIFICATION_MAX
import org.dias.mobile.domain.REQUEST_ACTIONS
import org.dias.mobile.domain.REQUEST_PURPOSES
import org.dias.mobile.domain.RequestProgress
import org.dias.mobile.domain.Session
import org.dias.mobile.domain.actionLabel
import org.dias.mobile.domain.purposeLabel

/**
 * The request card: an officer names a case file, an operation, a purpose and a reason, and follows the
 * request to its decision.
 */
internal class RequestPanel(private val context: Context, parent: LinearLayout) {
    private val card = context.card(parent)
    private val record: EditText
    private val action: Spinner
    private val purpose: Spinner
    private val reason: EditText
    /** Where the Activity puts its buttons, so that they follow the screen's busy state. */
    val sendControls = bar()
    val statusControls = bar()
    private val status = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL; tag = "request_status" }
    private val list = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL; tag = "request_list" }

    init {
        card.addView(context.label("Request access", 22, true))
        card.addView(context.label("A reusable authorization for this exact request is checked first. " +
            "Otherwise an auditor decides, advised by the LLM. The request is recorded on Fabric.", 13))
        card.addView(context.label("Case file", 13, true))
        record = EditText(context).apply {
            tag = "request_record"; hint = "For example REC-FIR-001"; setSingleLine(true)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            filters = arrayOf(InputFilter.LengthFilter(128))
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
        }.also { card.addView(it) }
        card.addView(context.label("Operation", 13, true))
        action = choice("request_action", REQUEST_ACTIONS.map(::actionLabel))
        card.addView(context.label("Purpose", 13, true))
        purpose = choice("request_purpose", REQUEST_PURPOSES.map(::purposeLabel))
        card.addView(context.label("Why do you need it?", 13, true))
        reason = EditText(context).apply {
            tag = "request_reason"; hint = "The LLM and the auditor read your reason"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
            minLines = 2; maxLines = 5; filters = arrayOf(InputFilter.LengthFilter(JUSTIFICATION_MAX))
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
        }.also { card.addView(it) }
        card.addView(sendControls)
        card.addView(status)
        card.addView(statusControls)
        card.addView(list)
    }

    /** What the form holds now. The reason is sent as typed, without its outer spaces. */
    fun draft() = AccessRequestDraft(record.text.toString().trim(),
        REQUEST_ACTIONS[action.selectedItemPosition], REQUEST_PURPOSES[purpose.selectedItemPosition],
        reason.text.toString())

    /** A reason that was sent is not kept on the screen. */
    fun clearReason() = reason.setText("")

    fun setEnabled(enabled: Boolean) {
        listOf(record, action, purpose, reason).forEach { it.isEnabled = enabled }
    }

    /**
     * Show the request being followed and the officer's own requests. Signed out, nothing of an earlier
     * sign-in stays: not what was read and not what was typed.
     */
    fun render(session: Session?, progress: RequestProgress?, own: List<AccessRequestStatus>?,
        busy: Boolean, open: (String) -> Unit) {
        if (session == null) {
            record.setText(""); reason.setText(""); action.setSelection(0); purpose.setSelection(0)
        }
        status.removeAllViews()
        progress?.lines()?.forEachIndexed { index, line ->
            status.addView(context.label(line, 13, bold = index == 2))
        }
        list.removeAllViews()
        if (own == null) return
        list.addView(context.label("My requests", 16, true))
        if (own.isEmpty()) list.addView(context.label("You have not made an access request.", 13))
        own.forEach { request ->
            val state = if (request.waiting) "waiting for an auditor" else request.status
            list.addView(context.label(
                "${request.requestId} · ${request.recordId} · ${request.action} · $state", 13))
            list.addView(Button(context).apply {
                tag = "request_open_${request.requestId}"; text = "Open"; isAllCaps = false; isEnabled = !busy
                setOnClickListener { open(request.requestId) }
            })
            context.divider(list)
        }
    }

    private fun choice(tag: String, labels: List<String>): Spinner = Spinner(context).apply {
        this.tag = tag
        adapter = ArrayAdapter(context, android.R.layout.simple_spinner_dropdown_item, labels)
    }.also { card.addView(it) }

    private fun bar() = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL }
}
