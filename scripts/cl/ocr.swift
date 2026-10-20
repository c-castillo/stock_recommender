// Text of a scanned PDF by macOS's own OCR (Vision), page by page, for the
// CMF notices some issuers file as images. lib/cl/cmf.ts compiles it once.
//
//   ocr <file.pdf>   → the text on stdout
import Foundation
import PDFKit
import Vision

guard CommandLine.arguments.count == 2, let doc = PDFDocument(url: URL(fileURLWithPath: CommandLine.arguments[1])) else {
  FileHandle.standardError.write("usage: ocr <file.pdf>\n".data(using: .utf8)!)
  exit(2)
}

for i in 0..<doc.pageCount {
  guard let page = doc.page(at: i) else { continue }
  let box = page.bounds(for: .mediaBox)
  let scale: CGFloat = 2.5
  let size = CGSize(width: box.width * scale, height: box.height * scale)
  guard let ctx = CGContext(data: nil, width: Int(size.width), height: Int(size.height), bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { continue }
  ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
  ctx.fill(CGRect(origin: .zero, size: size))
  ctx.scaleBy(x: scale, y: scale)
  page.draw(with: .mediaBox, to: ctx)
  guard let image = ctx.makeImage() else { continue }

  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.recognitionLanguages = ["es-ES", "en-US"]
  request.usesLanguageCorrection = true
  try? VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
  for line in request.results ?? [] {
    if let text = line.topCandidates(1).first?.string { print(text) }
  }
  print("\u{0C}")
}
