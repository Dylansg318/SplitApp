import java.util.Scanner;

public class Main {
    public static void main(String[] args) {
        Scanner scanner = new Scanner(System.in);

        // Step 1: Get the image path from the user
        System.out.println("Enter the path to the receipt image:");
        String imagePath = scanner.nextLine();

        // Step 2: Extract text from the image
        String extractedText = OCRProcessor.extractTextFromImage(imagePath);
        if (extractedText != null && !extractedText.isEmpty()) {
            System.out.println("Extracted Text:\n" + extractedText);

            // Step 3: Send extracted text to OpenAI to split the check
            String response = OpenAIChat.splitCheck(extractedText);
            System.out.println("OpenAI Response:\n" + response);
        } else {
            System.out.println("Failed to extract text from the image.");
        }

        scanner.close();
    }
}
