import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

public class OpenAIChat {
    /**
     * Read from the environment — never hard-coded, never committed.
     *   export OPENAI_API_KEY="sk-..."
     */
    private static final String API_KEY = System.getenv("OPENAI_API_KEY");
    private static final String OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";

    public static String splitCheck(String extractedText) {
        if (API_KEY == null || API_KEY.isBlank()) {
            return "Error: OPENAI_API_KEY is not set. Export it before running.";
        }

        String jsonBody = "{"
                + "\"model\": \"gpt-3.5-turbo\","
                + "\"messages\": [{\"role\": \"user\", \"content\": \"Given the following receipt text, please extract the total amount and help me split it between 3 people: " + extractedText + "\"}]"
                + "}";

        try {
            HttpClient client = HttpClient.newHttpClient();
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(OPENAI_API_URL))
                    .header("Content-Type", "application/json")
                    .header("Authorization", "Bearer " + API_KEY)
                    .POST(HttpRequest.BodyPublishers.ofString(jsonBody))
                    .build();

            HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());

            if (response.statusCode() == 200) {
                ObjectMapper objectMapper = new ObjectMapper();
                JsonNode jsonResponse = objectMapper.readTree(response.body());
                return jsonResponse.get("choices").get(0).get("message").get("content").asText();
            } else {
                return "Error: " + response.statusCode();
            }
        } catch (Exception e) {
            e.printStackTrace();
            return "Error processing the request.";
        }
    }
}
