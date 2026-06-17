import { Routes, Route } from 'react-router-dom';
import Home from './pages/Home';
import Scheduler from './pages/Scheduler';
import Worker from './pages/Worker';
import Gallery from './pages/Gallery';

function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/scheduler/:roomId?" element={<Scheduler />} />
      <Route path="/worker/:roomId?" element={<Worker />} />
      <Route path="/gallery" element={<Gallery />} />
    </Routes>
  );
}

export default App;
