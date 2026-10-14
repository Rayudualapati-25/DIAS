package org.dias.mobile.presentation

import android.app.Activity
import android.app.AlertDialog
import android.graphics.Color
import android.os.Bundle
import android.os.Build
import android.text.InputType
import android.text.InputFilter
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.dias.mobile.BuildConfig
import org.dias.mobile.data.ApiClient
import org.dias.mobile.data.ApiFailure
import org.dias.mobile.data.CaseDatabase
import org.dias.mobile.data.CaseRepository
import org.dias.mobile.data.HostAddress
import org.dias.mobile.domain.AccessLog
import org.dias.mobile.domain.AccessRequestStatus
import org.dias.mobile.domain.AuditorReview
import org.dias.mobile.domain.CaseSummary
import org.dias.mobile.domain.DecisionReceipt
import org.dias.mobile.domain.RequestProgress
import org.dias.mobile.domain.Session
import org.dias.mobile.domain.SyncState
import org.dias.mobile.domain.counted
import org.dias.mobile.domain.refusedWithoutWriting
import org.dias.mobile.domain.reviewStaysOpenAfter
import java.text.DateFormat
import java.util.Date
import java.util.concurrent.Executors

class MainActivity : Activity() {
    private val worker = Executors.newSingleThreadExecutor()
    private lateinit var database: CaseDatabase
    private lateinit var host: EditText
    private lateinit var username: EditText
    private lateinit var message: TextView
    private lateinit var account: TextView
    private lateinit var cacheInfo: TextView
    private lateinit var list: LinearLayout
    private lateinit var auditCard: LinearLayout
    private lateinit var auditInfo: TextView
    private lateinit var auditQueue: LinearLayout
    private lateinit var auditPanel: LinearLayout
    private lateinit var auditDetails: LinearLayout
    private lateinit var auditReason: EditText
    private lateinit var accessLogPanel: AccessLogPanel
    private lateinit var requestPanel: RequestPanel
    private val actions = mutableListOf<Pair<Button, () -> Boolean>>()
    private var session: Session? = null
    private var repository: CaseRepository? = null
    private var busy = false
    private var offset = 0
    private var rows: List<CaseSummary> = emptyList()
    private var total = 0
    private var sync: SyncState? = null
    private var pendingReviews: List<AuditorReview> = emptyList()
    private var selectedReview: AuditorReview? = null
    private var lastDecision: DecisionReceipt? = null
    private var accessLog: AccessLog? = null
    private var accessLogReadAt: Long? = null
    private var activeRequest: RequestProgress? = null
    private var ownRequests: List<AccessRequestStatus>? = null
    private var reasonSent = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        database = CaseDatabase(this)
        val body = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(22), dp(20), dp(22), dp(24))
        }
        val scroll = ScrollView(this).apply {
            setBackgroundColor(Color.parseColor("#F3F6F7")); addView(body)
            setOnApplyWindowInsetsListener { view, insets ->
                if (Build.VERSION.SDK_INT >= 30) {
                    val bars = insets.getInsets(android.view.WindowInsets.Type.systemBars())
                    view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
                } else {
                    @Suppress("DEPRECATION")
                    view.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop,
                        insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
                }
                insets
            }
        }
        setContentView(scroll)
        body.addView(label("DIAS", 32, true))
        body.addView(label("Mobile access portal", 17))
        body.addView(label("Access requests, auditor decisions, the access log and saved case summaries", 13))

        val connection = card(body)
        connection.addView(label("Connect to your host", 21, true))
        connection.addView(label("Host address", 13, true))
        host = EditText(this).apply {
            tag = "host"; hint = "https://your-host.example"; setSingleLine(true)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setText(getPreferences(MODE_PRIVATE).getString("host", BuildConfig.DEFAULT_HOST))
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
        }
        connection.addView(host)
        button(connection, "Check connection", "check", { true }) {
            val address = host.text.toString()
            perform("Checking host…") {
                ApiClient(HostAddress.normalize(address, BuildConfig.DEBUG)).health()
                "Host reachable. Sign in to check Fabric access."
            }
        }
        connection.addView(label("Demo identity", 13, true))
        username = EditText(this).apply {
            tag = "username"; hint = "Enrolled username"; setSingleLine(true)
            inputType = InputType.TYPE_CLASS_TEXT
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
        }
        connection.addView(username)
        connection.addView(label("Use an identity already enrolled on the Mac host. Demo sign-in selects a server-held identity.", 12))
        button(connection, "Sign in", "login", { session == null }) {
            val address = host.text.toString()
            val identity = username.text.toString().trim()
            perform("Signing in…") {
                require(identity.isNotEmpty()) { "Enter an enrolled username" }
                val normalized = HostAddress.normalize(address, BuildConfig.DEBUG)
                val remote = ApiClient(normalized)
                session = remote.login(identity)
                repository = CaseRepository(database, remote)
                pendingReviews = emptyList(); selectedReview = null; lastDecision = null
                offset = 0
                getPreferences(MODE_PRIVATE).edit().putString("host", normalized).apply()
                loadCache()
                if (session!!.canAudit) "Signed in. Refresh pending auditor reviews."
                else "Signed in. Load a batch to save summaries on this device."
            }
        }
        account = label("Signed out", 13, true).also { connection.addView(it) }
        button(connection, "Sign out and clear saved summaries", "logout", { session != null }) {
            perform("Signing out…") {
                database.clear(); forgetSession()
                "Signed out. Saved summaries cleared."
            }
        }
        message = label("Enter your host and check the connection.", 14).apply { tag = "message" }
        body.addView(message)

        requestPanel = RequestPanel(this, body)
        button(requestPanel.sendControls, "Request access", "request_submit", { session != null }) {
            sendRequest()
        }
        button(requestPanel.statusControls, "Check status", "request_check",
            { session != null && activeRequest != null }) {
            activeRequest?.let { readRequest(it.request.requestId) }
        }
        button(requestPanel.statusControls, "My requests", "request_mine", { session != null }) {
            perform("Reading your requests from Fabric…", "The list shown was not updated.") {
                val read = ApiClient(session!!.baseUrl).ownRequests(session!!)
                ownRequests = read
                "${read.size} of your requests read from Fabric."
            }
        }

        auditCard = card(body)
        auditCard.addView(label("Auditor decisions", 22, true))
        auditCard.addView(label("The LLM recommendation is advisory. Your decision is final and is recorded on Fabric.", 13))
        auditInfo = label("Refresh to load pending requests.", 13).apply { tag = "auditor_info" }
            .also { auditCard.addView(it) }
        button(auditCard, "Refresh pending reviews", "auditor_refresh", { session?.canAudit == true }) {
            perform("Loading pending reviews…", "The auditor queue was not updated.") {
                pendingReviews = ApiClient(session!!.baseUrl).pendingReviews(session!!)
                selectedReview = null
                "${counted(pendingReviews.size, "request", "requests")} awaiting an auditor."
            }
        }
        auditQueue = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; tag = "auditor_queue" }
        auditCard.addView(auditQueue)
        auditPanel = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; tag = "auditor_review" }
        auditCard.addView(auditPanel)
        auditPanel.addView(label("Review before making a final decision", 18, true))
        auditDetails = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; tag = "auditor_details" }
        auditPanel.addView(auditDetails)
        auditPanel.addView(label("Auditor reason", 13, true))
        auditReason = EditText(this).apply {
            tag = "auditor_reason"; hint = "Explain an override or decision without a recommendation"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
            minLines = 2; maxLines = 4; filters = arrayOf(InputFilter.LengthFilter(2000))
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
        }
        auditPanel.addView(auditReason)
        button(auditPanel, "Grant access", "auditor_allow", { canDecide() }) {
            confirmDecision("FORCE_ALLOW")
        }
        button(auditPanel, "Deny access", "auditor_deny", { canDecide() }) {
            confirmDecision("FORCE_DENY")
        }

        accessLogPanel = AccessLogPanel(this, body)
        button(accessLogPanel.controls, "Refresh access log", "access_log_refresh", { session != null }) {
            perform("Reading the access log from Fabric…", "The access log shown was not updated.") {
                val read = ApiClient(session!!.baseUrl).accessLog(session!!)
                accessLog = read; accessLogReadAt = System.currentTimeMillis()
                read.readMessage()
            }
        }

        val cases = card(body)
        cases.addView(label("Cases", 22, true))
        cacheInfo = label("Sign in to load case summaries.", 13).also { cases.addView(it) }
        button(cases, "Refresh first batch", "refresh", { session != null }) {
            perform("Loading first batch…") {
                val count = repository!!.fetchBatch(session!!, restart = true)
                offset = 0; loadCache()
                "Saved $count summaries from the host."
            }
        }
        button(cases, "Load next batch", "batch", { session != null && sync?.complete != true }) {
            perform("Loading next batch…") {
                val count = repository!!.fetchBatch(session!!)
                loadCache()
                "Saved $count more summaries. Use Next to browse them."
            }
        }
        list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; tag = "cases" }
        cases.addView(list)
        val navigation = LinearLayout(this).also { cases.addView(it) }
        button(navigation, "Previous", "previous", { session != null && offset > 0 }) {
            perform("Reading saved summaries…") {
                offset = (offset - 20).coerceAtLeast(0); loadCache(); "Showing saved summaries."
            }
        }
        button(navigation, "Next", "next", { session != null && offset + 20 < total }) {
            perform("Reading saved summaries…") {
                offset += 20; loadCache(); "Showing saved summaries."
            }
        }
        body.addView(label("Saved summaries can be browsed during a connection loss in this session. They may be out of date; access decisions still require the host.", 12))
        render()
    }

    /** Nothing that belonged to a sign-in stays in memory or on the screen. */
    private fun forgetSession() {
        session = null; repository = null; rows = emptyList(); total = 0; sync = null; offset = 0
        pendingReviews = emptyList(); selectedReview = null; lastDecision = null
        accessLog = null; accessLogReadAt = null
        activeRequest = null; ownRequests = null; reasonSent = false
    }

    /** Send what the request form holds, once. */
    private fun sendRequest() {
        val current = session ?: return
        val draft = requestPanel.draft()
        draft.problem()?.let { message.text = "$it Nothing was sent."; return }
        perform("Recording the request on Fabric…", "Nothing was sent.") {
            val recorded = try {
                ApiClient(current.baseUrl).submit(current, draft)
            } catch (error: Exception) {
                val status = (error as? ApiFailure)?.status
                if (status == 401) throw error // The session ended; perform() signs out.
                return@perform "${error.message ?: "Connection failed"}. " + if (refusedWithoutWriting(status))
                    "Nothing was recorded. You can correct the request and send it again."
                else "The request may have been recorded. Read My requests before sending it again."
            }
            activeRequest = RequestProgress(recorded); reasonSent = true
            recorded.submittedMessage()
        }
    }

    /** Read one of the officer's requests from the ledger and follow it on the request card. */
    private fun readRequest(requestId: String) {
        perform("Reading the request from Fabric…", "The request shown was not updated.") {
            val read = ApiClient(session!!.baseUrl).progress(session!!, requestId)
            activeRequest = read
            read.message()
        }
    }

    private fun loadCache() {
        val current = session ?: return
        rows = repository!!.cached(current, 20, offset)
        total = repository!!.count(current)
        sync = repository!!.state(current)
    }

    private fun perform(progress: String, failureContext: String = "Saved summaries are unchanged.",
        task: () -> String) {
        if (busy) return
        busy = true; message.text = progress; renderControls()
        worker.execute {
            val result = try { task() } catch (error: Exception) {
                if (error is ApiFailure && error.status == 401) {
                    database.clear(); forgetSession()
                    "Session expired. Sign in again."
                } else {
                    "${error.message ?: "Connection failed"}. $failureContext"
                }
            }
            runOnUiThread {
                if (!isDestroyed) {
                    busy = false; message.text = result; render()
                }
            }
        }
    }

    private fun renderControls() {
        actions.forEach { (button, enabled) -> button.isEnabled = !busy && enabled() }
        host.isEnabled = !busy && session == null
        username.isEnabled = !busy && session == null
        auditReason.isEnabled = !busy && selectedReview != null
        requestPanel.setEnabled(!busy && session != null)
    }

    private fun render() {
        renderControls()
        account.text = session?.let { "${it.username} · ${it.org}" } ?: "Signed out"
        renderAudit()
        if (reasonSent) { requestPanel.clearReason(); reasonSent = false }
        requestPanel.render(session, activeRequest, ownRequests, busy) { if (!busy) readRequest(it) }
        accessLogPanel.render(session, accessLog, accessLogReadAt)
        cacheInfo.text = when {
            session == null -> "Sign in to load case summaries."
            sync == null -> "No saved summaries yet."
            total == 0 -> "No cases returned by the host."
            else -> "${offset + 1}–${(offset + rows.size).coerceAtMost(total)} of $total saved · " +
                "Updated ${DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(sync!!.fetchedAt))}" +
                if (sync!!.complete) " · All batches loaded" else " · More on host"
        }
        list.removeAllViews()
        rows.forEach { row ->
            val item = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL; setPadding(0, dp(12), 0, dp(12))
            }
            item.addView(label(row.caseId, 17, true))
            item.addView(label("${row.owningAgency} · ${row.jurisdiction}", 13))
            item.addView(label(row.status.replace('-', ' '), 13))
            list.addView(item)
            divider(list)
        }
    }

    private fun canDecide(): Boolean {
        val current = session ?: return false
        return selectedReview?.blockingReason(current) == null && selectedReview != null
    }

    private fun confirmDecision(decision: String) {
        val review = selectedReview ?: return
        val current = session ?: return
        val blocked = review.blockingReason(current)
        if (blocked != null) { message.text = blocked; return }
        val reason = auditReason.text.toString().trim()
        if (review.requiresReason(decision) && reason.isEmpty()) {
            auditReason.error = "A reason is required when your decision differs from the LLM or none exists"
            return
        }
        val grant = decision == "FORCE_ALLOW"
        val consequence = if (review.createsAuthorization(decision))
            "This also creates an exact-scope reusable authorization."
        else "No reusable authorization will be created."
        AlertDialog.Builder(this)
            .setTitle(if (grant) "Grant access?" else "Deny access?")
            .setMessage("${review.requesterUsername} · ${review.recordId} · ${review.action} / ${review.purpose}\n" +
                "LLM advice: ${review.llmRecommendation ?: "unavailable"}.\n$consequence\n" +
                "This final decision will be recorded on Fabric.")
            .setNegativeButton("Cancel", null)
            .setPositiveButton(if (grant) "Record grant" else "Record denial") { _, _ ->
                perform("Recording final decision…", "Nothing was sent.") {
                    val receipt = try {
                        ApiClient(current.baseUrl).decide(current, review, decision, reason)
                    } catch (error: IllegalArgumentException) {
                        throw error // Refused on the phone before anything was sent.
                    } catch (error: Exception) {
                        val status = (error as? ApiFailure)?.status
                        if (status == 401) throw error // The session ended; perform() signs out.
                        return@perform unconfirmed(error, status)
                    }
                    pendingReviews = pendingReviews.filterNot { it.requestId == review.requestId }
                    selectedReview = null; lastDecision = receipt
                    if (receipt.confirmedFromLedger) {
                        "Fabric confirms ${receipt.outcome} for ${review.requestId} " +
                            "(${receipt.outcomeId}). The requester can see the final outcome."
                    } else {
                        "Decision submitted for ${review.requestId}, but the Fabric readback was unavailable. " +
                            "Refresh or inspect the request before trying again."
                    }
                }
            }.show()
    }

    /** What the screen says when a decision was not confirmed. */
    private fun unconfirmed(error: Exception, httpStatus: Int?): String {
        val refused = reviewStaysOpenAfter(httpStatus)
        if (!refused) selectedReview = null
        return "${error.message ?: "Connection failed"}. " + if (refused)
            "Nothing was recorded. You can correct the decision and send it again."
        else "The decision may have been recorded. Refresh the queue before deciding again."
    }

    private fun renderAudit() {
        val auditing = session?.canAudit == true
        auditCard.visibility = if (auditing) View.VISIBLE else View.GONE
        auditQueue.removeAllViews()
        auditDetails.removeAllViews()
        if (selectedReview == null) {
            // A closed review leaves nothing behind, shown or hidden: not its facts, not the typed reason.
            auditPanel.visibility = View.GONE
            auditReason.setText(""); auditReason.error = null
        }
        if (!auditing) { auditInfo.text = ""; return }
        auditInfo.text = lastDecision?.let {
            "Last decision: ${it.outcome} · ${it.outcomeId}" +
                if (it.confirmedFromLedger) " · verified on Fabric" else " · verify on host"
        } ?: "${pendingReviews.size} pending requests · Press Refresh to check for new advice."
        if (pendingReviews.isEmpty()) auditQueue.addView(label("No pending requests loaded.", 13))
        pendingReviews.forEach { review ->
            val item = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(0, dp(10), 0, dp(10)) }
            item.addView(label("${review.recordId} · ${review.requesterUsername}", 16, true))
            item.addView(label("${review.action} / ${review.purpose} · LLM: " +
                if (review.integrityStatus == "verified") (review.llmRecommendation ?: "unavailable")
                else "${review.recommendationState} (${review.integrityStatus})", 13))
            val open = Button(this).apply {
                tag = "review_${review.requestId}"; text = "Review"; isAllCaps = false; isEnabled = !busy
                setOnClickListener {
                    if (!busy) {
                        auditReason.setText("")
                        perform("Opening review…", "The review was not updated.") {
                            val opened = ApiClient(session!!.baseUrl).review(session!!, review.requestId)
                            selectedReview = opened
                            "Review ${opened.requestId}. Check the facts and LLM advice before deciding."
                        }
                    }
                }
            }
            item.addView(open); auditQueue.addView(item)
        }
        val review = selectedReview ?: return
        auditPanel.visibility = View.VISIBLE
        fun fact(name: String, value: Any?) = auditDetails.addView(label("$name: ${value ?: "—"}", 13))
        fact("Request", review.requestId)
        fact("Requester", "${review.requesterUsername} · ${review.requesterRole ?: "role unknown"} · " +
            (review.requesterOrganization ?: "organisation unknown"))
        fact("Clearance / credential", "${review.requesterClearance ?: "—"} / ${review.credentialStatus ?: "—"}")
        fact("Assigned to case", review.assignedToCase)
        fact("Record / case", "${review.recordId} / ${review.caseId}")
        fact("Record type / sensitivity", "${review.recordType ?: "—"} / ${review.sensitivity ?: "—"}")
        fact("Jurisdiction / owner", "${review.jurisdiction ?: "—"} / ${review.owningAgency ?: "—"}")
        fact("Protection flags", "sealed=${review.sealed}, juvenile=${review.juvenile}, " +
            "witness=${review.witness}, victim=${review.victimProtected}")
        fact("Requested action / purpose", "${review.action} / ${review.purpose}")
        fact("Requester justification (unverified claim)", review.justification)
        fact("LLM state / generation", "${review.recommendationState} / ${review.generationStatus ?: "—"}")
        fact("Commitment check", review.integrityStatus)
        if (review.integrityProblems.isNotEmpty()) fact("Integrity issues", review.integrityProblems.joinToString("; "))
        fact("LLM recommendation (advisory)", when (review.integrityStatus) {
            "verified" -> review.llmRecommendation ?: "No recommendation"
            "no-commitment" -> "No committed recommendation"
            else -> "Cannot be verified"
        })
        if (review.integrityStatus == "verified") fact("LLM explanation", review.llmReason)
        fact("Allow consequence", if (review.createsAuthorization("FORCE_ALLOW"))
            "Grant and create exact-scope reusable authorization" else "Grant this request")
        fact("Deny consequence", "Deny this request")
        review.blockingReason(session!!)?.let { fact("Decision unavailable", it) }
    }

    private fun button(parent: LinearLayout, text: String, tag: String,
        enabled: () -> Boolean, action: () -> Unit) {
        val control = Button(this).apply {
            this.text = text; this.tag = tag; isAllCaps = false
            setOnClickListener { action() }
        }
        actions.add(control to enabled); parent.addView(control)
    }

    override fun onDestroy() {
        // Finish an in-flight page transaction before closing the database.
        worker.execute { database.close() }; worker.shutdown()
        super.onDestroy()
    }
}
