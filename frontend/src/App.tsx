import { Routes, Route } from "react-router-dom";
import { Layout } from "./components/Layout";
import { HomePage } from "./pages/HomePage";
import { ForumDiscoveryPage } from "./pages/ForumDiscoveryPage";
import { CreateForumPage } from "./pages/CreateForumPage";
import { ForumHubPage } from "./pages/ForumHubPage";
import { CreatePostPage } from "./pages/CreatePostPage";
import { PostDetailPage } from "./pages/PostDetailPage";
import { UserProfilePage } from "./pages/UserProfilePage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { ErrorBoundary } from "./components/ErrorBoundary";

function App() {
  return (
    <ErrorBoundary>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<HomePage />} />
          <Route path="forums" element={<ForumDiscoveryPage />} />
          <Route path="forums/new" element={<CreateForumPage />} />
          <Route path="f/:forumKey" element={<ForumHubPage />} />
          <Route path="f/:forumKey/submit" element={<CreatePostPage />} />
          <Route path="f/:forumKey/p/:postId" element={<PostDetailPage />} />
          <Route path="u/:wallet" element={<UserProfilePage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </ErrorBoundary>
  );
}

export default App;