import net.sourceforge.tess4j.Tesseract;
import net.sourceforge.tess4j.TesseractException;
import java.io.File;

public class OCRProcessor {

    /**
     * Where Tesseract's language data lives. Overridable so the program is not
     * pinned to one machine's Downloads folder:
     *   TESSDATA_PREFIX=/opt/homebrew/share/tessdata
     */
    private static final String DEFAULT_DATAPATH = "/opt/homebrew/share/tessdata";

    private static String datapath() {
        String fromEnv = System.getenv("TESSDATA_PREFIX");
        return (fromEnv != null && !fromEnv.isBlank()) ? fromEnv : DEFAULT_DATAPATH;
    }

    public static String extractTextFromImage(String imagePath) {
        Tesseract tesseract = new Tesseract();
        tesseract.setDatapath(datapath());

        try {
            // Set the language for OCR (optional, based on your image)
            tesseract.setLanguage("eng");

            // Extract text from the image
            String extractedText = tesseract.doOCR(new File(imagePath));
            return extractedText;
        } catch (TesseractException e) {
            e.printStackTrace();
            return null;
        }
    }
}
