package org.dias.mobile.presentation

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView

/** The few view pieces every part of the screen is built from. */

internal val INK = Color.parseColor("#183C42")
internal val RULE = Color.parseColor("#E0E7E9")

internal fun Context.dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

internal fun Context.label(text: String, size: Int, bold: Boolean = false): TextView = TextView(this).apply {
    this.text = text; textSize = size.toFloat(); setTextColor(INK)
    setPadding(0, dp(4), 0, dp(4))
    if (bold) setTypeface(typeface, Typeface.BOLD)
}

internal fun Context.card(parent: LinearLayout): LinearLayout = LinearLayout(this).apply {
    orientation = LinearLayout.VERTICAL; setPadding(dp(16), dp(16), dp(16), dp(16))
    background = GradientDrawable().apply {
        setColor(Color.WHITE); cornerRadius = dp(14).toFloat()
    }
    parent.addView(this, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(18); bottomMargin = dp(10) })
}

/** A thin rule between two list items, added to `parent`. */
internal fun Context.divider(parent: LinearLayout) {
    parent.addView(View(this).apply { setBackgroundColor(RULE) },
        LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(1)))
}
