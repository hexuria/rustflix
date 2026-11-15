// `rustflix.spinner` (app/lib/nativespinner.tsx): the system activity
// indicator, centred in the box the app lays out. Props: `large` (the large
// style from 32 pt up), `color` ("#rrggbb" / "#aarrggbb").

import NativeShell
import UIKit

final class NativeSpinnerComponent: NSObject, NshComponent {
    private let spinner = UIActivityIndicatorView(style: .medium)
    private var color = UIColor(white: 0.83, alpha: 1)

    var view: UIView { spinner }

    init(_ ctx: NshComponentContext) {
        super.init()
        spinner.hidesWhenStopped = false
        spinner.color = color
        spinner.startAnimating()
    }

    func setProp(_ name: String, _ value: Any?) {
        switch name {
        case "large":
            // A style change resets the colour.
            spinner.style = (value as? Bool) == true ? .large : .medium
            spinner.color = color
        case "color":
            if let s = value as? String, let c = NativeSpinnerComponent.parse(s) {
                color = c
                spinner.color = c
            }
        default:
            break
        }
        if !spinner.isAnimating { spinner.startAnimating() }
    }

    /// "#rrggbb" or "#aarrggbb".
    private static func parse(_ text: String) -> UIColor? {
        var hex = text.trimmingCharacters(in: .whitespaces)
        guard hex.hasPrefix("#") else { return nil }
        hex.removeFirst()
        guard hex.count == 6 || hex.count == 8, let v = UInt64(hex, radix: 16) else { return nil }
        let a = hex.count == 8 ? CGFloat((v >> 24) & 0xff) / 255 : 1
        return UIColor(
            red: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255,
            blue: CGFloat(v & 0xff) / 255, alpha: a)
    }

    static func register(_ appView: NshAppView) {
        appView.register(component: "rustflix.spinner") { ctx in NativeSpinnerComponent(ctx) }
    }
}
