package org.dias.mobile.screen

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.os.SystemClock
import android.text.Editable
import android.text.TextWatcher
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.EditText
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.TextView
import androidx.test.platform.app.InstrumentationRegistry
import org.dias.mobile.presentation.MainActivity
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import java.io.Closeable
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Drives the app's one screen the way a person does: by what is shown and enabled. */
class Screen : Closeable {
    private val instrument = InstrumentationRegistry.getInstrumentation()
    private val activity = instrument.startActivitySync(
        Intent(instrument.targetContext, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    ) as MainActivity
    private val savedHost = activity.getPreferences(Activity.MODE_PRIVATE).getString("host", null)

    private fun <T : View> view(tag: String): T {
        val found = activity.window.decorView.findViewWithTag<T>(tag)
        assertNotNull("No view tagged '$tag'", found)
        return found
    }

    /** Read or act on the app's main thread. */
    private fun <T> onMain(read: () -> T): T {
        var outcome: Result<T>? = null
        instrument.runOnMainSync { outcome = runCatching(read) }
        return outcome!!.getOrThrow()
    }

    /** A view counts as offered only when a person could see and use it. */
    fun isOffered(tag: String): Boolean = onMain { view<View>(tag).run { isShown && isEnabled } }
    fun isShown(tag: String): Boolean = onMain { view<View>(tag).isShown }
    fun text(tag: String): String = onMain { view<TextView>(tag).text.toString() }
    fun error(tag: String): String? = onMain { view<TextView>(tag).error?.toString() }

    /** Every line of text under a container, top to bottom. */
    fun lines(tag: String): List<String> = onMain {
        val found = mutableListOf<String>()
        fun collect(node: View) {
            if (node is TextView) found.add(node.text.toString())
            else if (node is ViewGroup) (0 until node.childCount).forEach { collect(node.getChildAt(it)) }
        }
        collect(view(tag))
        found
    }

    fun click(tag: String) = onMain {
        val target = view<View>(tag)
        assertTrue("'$tag' is not offered on the screen", target.isShown && target.isEnabled)
        target.performClick()
    }

    fun type(tag: String, value: String) = onMain { view<EditText>(tag).setText(value) }

    /** Pick the entry of a drop-down list that carries this label. */
    fun choose(tag: String, label: String) = onMain {
        val list = view<Spinner>(tag)
        val index = (0 until list.count).firstOrNull { list.getItemAtPosition(it).toString() == label }
        assertNotNull("'$tag' offers no '$label'", index)
        list.setSelection(index!!)
    }

    /** Wait for the screen's message line. A timed step polls more often (`pollMillis`). */
    fun awaitMessage(expected: String, timeoutMillis: Long = 20_000, pollMillis: Long = 100): String {
        val deadline = SystemClock.uptimeMillis() + timeoutMillis
        var value: String
        do {
            value = text("message")
            if (value.contains(expected)) return value
            Thread.sleep(pollMillis)
        } while (SystemClock.uptimeMillis() < deadline)
        fail("Expected a message containing '$expected', the screen says '$value'")
        return value
    }

    /**
     * How long the screen takes to show a message, in milliseconds, from just before `trigger` to the
     * moment the message line changes to it.
     */
    fun timeToMessage(expected: String, timeoutMillis: Long = 90_000, trigger: () -> Unit): Double =
        timeToMessageThat("containing '$expected'", timeoutMillis, { it.contains(expected) }, trigger)

    /** The same for the first message that `matches`, when a step can end in more than one way. */
    fun timeToMessageThat(described: String, timeoutMillis: Long = 90_000, matches: (String) -> Boolean,
        trigger: () -> Unit): Double {
        val shown = CountDownLatch(1)
        var shownAt = 0L
        val watcher = object : TextWatcher {
            override fun beforeTextChanged(text: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(text: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(text: Editable?) {
                if (shownAt == 0L && matches(text.toString())) {
                    shownAt = SystemClock.elapsedRealtimeNanos()
                    shown.countDown()
                }
            }
        }
        onMain { view<TextView>("message").addTextChangedListener(watcher) }
        try {
            val startedAt = SystemClock.elapsedRealtimeNanos()
            trigger()
            if (!shown.await(timeoutMillis, TimeUnit.MILLISECONDS)) {
                fail("Expected a message $described, the screen says '${text("message")}'")
            }
            return (shownAt - startedAt) / 1_000_000.0
        } finally {
            onMain { view<TextView>("message").removeTextChangedListener(watcher) }
        }
    }

    /** Keep the display on for a long session; a sleeping screen stops the app's window. */
    fun keepScreenOn() = onMain { activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }

    fun signIn(host: String, username: String) {
        type("host", host)
        type("username", username)
        click("login")
        awaitMessage("Signed in")
    }

    /** Press a button of the confirmation dialog, which lives in its own window. */
    fun pressDialogButton(label: String) = dialogButton(label)()

    /**
     * Find a button of the confirmation dialog now and return the press itself, so that a timed step can
     * start at the press and leave the search out.
     */
    fun dialogButton(label: String): () -> Unit {
        val button = dialogNode(label) { it.isClickable }
        return { assertTrue("'$label' could not be pressed", button.performAction(AccessibilityNodeInfo.ACTION_CLICK)) }
    }

    /**
     * The confirmation dialog's message, once the dialog is on the screen. It is found by the sentence only
     * the dialog carries, never by words the page behind it also shows.
     */
    fun dialogMessage(): String = dialogNode(DIALOG_SENTENCE) { true }.text.toString()

    private fun dialogNode(text: String, accept: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo {
        val deadline = SystemClock.uptimeMillis() + 10_000
        do {
            val match = instrument.uiAutomation.rootInActiveWindow
                ?.findAccessibilityNodeInfosByText(text)?.firstOrNull(accept)
            if (match != null) return match
            Thread.sleep(100)
        } while (SystemClock.uptimeMillis() < deadline)
        fail("Nothing on the screen says '$text'")
        throw IllegalStateException()
    }

    /** Bring a tagged view to the top of the visible page, for a screenshot. */
    fun reveal(tag: String) {
        instrument.waitForIdleSync()
        onMain {
            val target = view<View>(tag)
            var top = 0
            var node: View = target
            while (node.parent is View && node.parent !is ScrollView) {
                top += node.top
                node = node.parent as View
            }
            (node.parent as? ScrollView)?.scrollTo(0, (top - 24).coerceAtLeast(0))
        }
        instrument.waitForIdleSync()
        Thread.sleep(400)
    }

    fun isSelected(tag: String): Boolean = onMain { view<View>(tag).isSelected }

    /** Save what the display shows; kept only when the app stays installed after the run. */
    fun screenshot(name: String) {
        instrument.waitForIdleSync()
        val folder = File(instrument.targetContext.cacheDir, "evidence").apply { mkdirs() }
        val image = instrument.uiAutomation.takeScreenshot() ?: return
        File(folder, "$name.png").outputStream().use { image.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    /** Keep a small result file beside the screenshots, for the host to collect. */
    fun saveText(name: String, content: String) {
        File(instrument.targetContext.cacheDir, "evidence").apply { mkdirs() }.resolve(name).writeText(content)
    }

    private companion object {
        const val DIALOG_SENTENCE = "This final decision will be recorded on Fabric"
    }

    override fun close() {
        onMain {
            // A scripted host's address must not be left as the app's saved host.
            activity.getPreferences(Activity.MODE_PRIVATE).edit().apply {
                if (savedHost == null) remove("host") else putString("host", savedHost)
            }.apply()
            activity.finish()
        }
    }
}
